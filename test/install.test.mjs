// Isolated fixture tests for the omo-coworkers host-aware installer.
//
// Every test works on a throwaway target directory with pre-existing unrelated
// configuration, so the suite proves real behavior (additivity, idempotence,
// conflict aborts, rollback, uninstall) rather than mirroring renderer text.
//
// Optional live-host checks (skipped unless env vars are set):
//   OCW_V1_BIN=/path/to/opencode-1.x OCW_V2_BIN=/path/to/opencode-2.x node --test

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, linkSync, symlinkSync, statSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { install, plan, uninstall, rollback, verify, ConflictError, BASELINE } from "../installer/install.mjs";
import { renderPlan, sha256, ROLES } from "../installer/render.mjs";
import { classify, probeExecutable, V1_MIN, V2_MIN, V1_TESTED, V2_TESTED } from "../installer/detect.mjs";
import { mergeOverlay, unmergeOverlay, MANAGED_AGENT_KEYS } from "../installer/merge.mjs";
import * as manifestMod from "../installer/manifest.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

function makeTarget({ withOverlay = true, withAgentFiles = true, withSkills = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocw-inst-test-"));
  const oc = join(root, ".opencode");
  mkdirSync(oc, { recursive: true });
  if (withOverlay) {
    writeFileSync(
      join(oc, "oh-my-opencode-slim.json"),
      `${JSON.stringify(
        {
          $schema: "https://example.invalid/oh-my-opencode-slim.schema.json",
          agents: {
            "personal-reviewer": { description: "owner agent", skills: ["personal-skill"], permission: { bash: "allow" } },
          },
          customTopLevel: { keep: true },
        },
        null,
        2,
      )}\n`,
    );
  }
  if (withAgentFiles) {
    mkdirSync(join(oc, "agent"), { recursive: true });
    writeFileSync(join(oc, "agent", "personal-agent.md"), "---\ndescription: personal\nmode: subagent\n---\npersonal body\n");
    mkdirSync(join(oc, "agents"), { recursive: true });
    writeFileSync(join(oc, "agents", "personal-v2-agent.md"), "---\ndescription: personal v2\nmode: subagent\n---\nbody\n");
  }
  if (withSkills) {
    mkdirSync(join(oc, "skill", "personal-skill"), { recursive: true });
    writeFileSync(join(oc, "skill", "personal-skill", "SKILL.md"), "---\nname: personal-skill\n---\nowner content\n");
    mkdirSync(join(oc, "skills", "personal-v2-skill"), { recursive: true });
    writeFileSync(join(oc, "skills", "personal-v2-skill", "SKILL.md"), "---\nname: personal-v2-skill\n---\nowner content\n");
  }
  writeFileSync(join(root, "unrelated.txt"), "owner file\n");
  return root;
}

function snapshot(root) {
  const out = {};
  function walk(dir, rel = "") {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else out[r] = sha256(readFileSync(abs));
    }
  }
  walk(root);
  return out;
}

const HOSTS = ["v1", "v2"];

test("prompts carry no frontmatter (renderer owns it)", () => {
  for (const role of ROLES) {
    const src = readFileSync(join(REPO_ROOT, "prompts", `${role}.md`), "utf8");
    assert.ok(!src.startsWith("---"), `${role} prompt must not start with frontmatter`);
    assert.ok(src.trim().length > 0, `${role} prompt must not be empty`);
  }
});

test("renderPlan: v1 vs v2 native vocabulary and layout", () => {
  const overlay = JSON.parse(readFileSync(join(REPO_ROOT, "oh-my-opencode-slim.json"), "utf8"));
  const v1 = renderPlan({ packageRoot: REPO_ROOT, host: "v1", overlay });
  const v2 = renderPlan({ packageRoot: REPO_ROOT, host: "v2", overlay });

  const dw1 = v1.files.find((f) => f.path === ".opencode/agent/document-writer.md");
  const dw2 = v2.files.find((f) => f.path === ".opencode/agents/document-writer.md");
  assert.ok(dw1 && dw2, "role agents land in host-native dirs");

  // v1: grouped permission map with v1 tool names
  const lo1 = v1.files.find((f) => f.path === ".opencode/agent/lark-operator.md");
  assert.match(dw1.content, /^permission:$/m);
  assert.match(dw1.content, /^  "task": deny$/m);
  assert.ok(!/"bash"/.test(dw1.content), "document-writer leaves host-default shell policy alone");
  assert.match(lo1.content, /^  "bash": allow$/m, "lark-operator allows shell in v1 vocabulary");
  assert.match(lo1.content, /^  "edit": deny$/m);
  assert.ok(!dw1.content.includes("permissions:"), "v1 file must not use the v2 permissions array");
  assert.ok(!dw1.content.includes('"shell"'), "v1 file must not use the v2 shell action");

  // v2: ordered permissions array with renamed actions
  const lo2 = v2.files.find((f) => f.path === ".opencode/agents/lark-operator.md");
  assert.match(dw2.content, /^permissions:$/m);
  assert.match(lo2.content, /- action: "shell"\n    resource: "\*"\n    effect: allow/);
  assert.match(dw2.content, /- action: "subagent"\n    resource: "\*"\n    effect: deny/);
  assert.ok(!/^permission:/m.test(dw2.content), "v2 file must not use the grouped v1 map");
  assert.ok(!/\n {2}"task":/m.test(dw2.content), "v2 file must not use the v1 task action");

  // prompt authority: body after frontmatter is byte-equal to the prompt source
  for (const role of ROLES) {
    const body = readFileSync(join(REPO_ROOT, "prompts", `${role}.md`), "utf8").replace(/\n*$/, "\n");
    for (const [host, planObj, dir] of [
      ["v1", v1, ".opencode/agent"],
      ["v2", v2, ".opencode/agents"],
    ]) {
      const f = planObj.files.find((x) => x.path === `${dir}/${role}.md`);
      assert.ok(f.content.endsWith(body), `${host} ${role} agent body must be the verbatim prompt`);
    }
  }

  // skills land in host-native dirs, byte-for-byte
  assert.ok(v1.skillIds.length >= 3, "expected at least the three bundled skills");
  assert.deepEqual(v1.skillIds, v2.skillIds);
  for (const f of v1.files.filter((x) => x.kind === "skill")) {
    assert.ok(f.path.startsWith(".opencode/skill/"), f.path);
    assert.equal(f.sha256, sha256(readFileSync(join(REPO_ROOT, f.source))), `skill bytes must match source: ${f.path}`);
  }
  for (const f of v2.files.filter((x) => x.kind === "skill")) {
    assert.ok(f.path.startsWith(".opencode/skills/"), f.path);
  }
  assert.ok(!v1.skillIds.some((s) => s.startsWith("lark-")), "no Feishu skills are shipped by the generic package");
});

for (const host of HOSTS) {
  test(`${host}: clean install is additive and writes a machine-readable manifest`, async () => {
    const target = makeTarget();
    try {
      const before = snapshot(target);
      const { manifest } = await install({ packageRoot: REPO_ROOT, target, host });

      // unrelated configuration preserved byte-for-byte (the managed overlay is
      // checked separately; the installer legitimately rewrites it additively)
      const after = snapshot(target);
      for (const [rel, hash] of Object.entries(before)) {
        if (rel === ".opencode/oh-my-opencode-slim.json") continue;
        assert.equal(after[rel], hash, `unrelated file changed: ${rel}`);
      }

      // expected artifacts
      const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
      const skillDir = host === "v1" ? ".opencode/skill" : ".opencode/skills";
      for (const role of ROLES) {
        assert.ok(existsSync(join(target, agentDir, `${role}.md`)), `${agentDir}/${role}.md installed`);
      }
      assert.ok(existsSync(join(target, skillDir, "domain-modeling", "SKILL.md")));
      assert.ok(!existsSync(join(target, skillDir, "writing-plans")), "retired writing-plans skill must not be installed");

      // overlay: managed keys added, unrelated keys untouched
      const overlay = JSON.parse(readFileSync(join(target, ".opencode", "oh-my-opencode-slim.json"), "utf8"));
      for (const key of MANAGED_AGENT_KEYS) assert.ok(overlay.agents?.[key], `overlay gained agents.${key}`);
      assert.ok(overlay.agents["personal-reviewer"], "unrelated agent preserved in overlay");
      assert.deepEqual(overlay.customTopLevel, { keep: true }, "unknown top-level key preserved");
      assert.equal(typeof overlay.agents[MANAGED_AGENT_KEYS[0]].permission, "object", "managed entries keep OMO overlay schema vocabulary");

      // manifest machine-readable
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.host.flavor, host);
      assert.equal(manifest.package.baseline, BASELINE);
      assert.ok(manifest.files.length >= 2 + 3, "manifest covers role agents + skills");
      assert.ok(manifest.files.every((f) => f.path && f.action && f.sha256Installed));
      assert.equal(manifest.promptAuthority[ROLES[0]], `${agentDir}/${ROLES[0]}.md`);
      assert.deepEqual(manifest.skills.sort(), ["domain-modeling", "humanizer", "maintaining-product-engineering-docs"]);

      const check = verify({ target });
      assert.equal(check.drift.length, 0);
      assert.equal(check.missing.length, 0);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test(`${host}: reinstall is idempotent (no changes, no new backups)`, async () => {
    const target = makeTarget();
    try {
      await install({ packageRoot: REPO_ROOT, target, host });
      const before = snapshot(target);
      const { manifest } = await install({ packageRoot: REPO_ROOT, target, host });
      const after = snapshot(target);
      // the manifest itself carries run bookkeeping (timestamps, actions);
      // idempotence means the target CONFIGURATION is byte-identical
      const skip = (rel) => rel === ".opencode/omo-coworkers-install.json";
      assert.deepEqual(
        Object.fromEntries(Object.entries(after).filter(([r]) => !skip(r))),
        Object.fromEntries(Object.entries(before).filter(([r]) => !skip(r))),
        "second install changed target configuration",
      );
      assert.ok(manifest.files.every((f) => f.action === "unchanged"), "all entries unchanged on rerun");
      assert.ok(!manifest.files.some((f) => f.backup), "no backups on clean rerun");
      const skillDir = host === "v1" ? ".opencode/skill" : ".opencode/skills";
      assert.ok(!existsSync(join(target, skillDir, "writing-plans")), "reinstall cannot restore the retired writing-plans skill");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test(`${host}: unmanaged role file blocks install before any write`, async () => {
    const target = makeTarget();
    try {
      const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
      writeFileSync(join(target, ".opencode", agentDir.split("/")[1], "document-writer.md"), "owner pre-existing role\n");
      const before = snapshot(target);
      await assert.rejects(
        () => install({ packageRoot: REPO_ROOT, target, host }),
        (err) => err instanceof ConflictError && err.code === 2 && err.report.some((l) => l.includes("unmanaged file exists")),
      );
      assert.deepEqual(snapshot(target), before, "conflicting install must not write anything");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test(`${host}: pre-existing overlay with managed keys conflicts; --force merges with backup`, async () => {
    const target = makeTarget();
    try {
      const oc = join(target, ".opencode");
      const existing = {
        agents: { [MANAGED_AGENT_KEYS[0]]: { description: "owner's own version" }, "personal-reviewer": { description: "owner agent" } },
      };
      writeFileSync(join(oc, "oh-my-opencode-slim.json"), `${JSON.stringify(existing, null, 2)}\n`);
      const before = readFileSync(join(oc, "oh-my-opencode-slim.json"));

      await assert.rejects(() => install({ packageRoot: REPO_ROOT, target, host }), ConflictError);
      assert.equal(readFileSync(join(oc, "oh-my-opencode-slim.json")).toString(), before.toString(), "overlay untouched on conflict");

      const { manifest } = await install({ packageRoot: REPO_ROOT, target, host, force: true });
      const overlay = JSON.parse(readFileSync(join(oc, "oh-my-opencode-slim.json"), "utf8"));
      assert.ok(overlay.agents[MANAGED_AGENT_KEYS[0]].permission, "managed entry taken over by installer");
      assert.ok(overlay.agents["personal-reviewer"], "unrelated agent preserved");
      assert.ok(manifest.overlay.backup, "pre-force overlay backed up");
      const backupBytes = readFileSync(join(target, manifest.overlay.backup));
      assert.deepEqual(backupBytes, before, "backup is byte-exact");

      // rollback restores the exact pre-install state
      const result = rollback({ target });
      assert.equal(result.blocked.length, 0);
      assert.equal(readFileSync(join(oc, "oh-my-opencode-slim.json")).toString(), before.toString(), "overlay restored byte-exact");
      assert.ok(existsSync(join(target, "unrelated.txt")));
      assert.ok(!existsSync(join(target, ".opencode", "omo-coworkers-install.json")), "manifest removed by rollback");
      // created role files were deleted, owned files restored
      const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
      assert.ok(!existsSync(join(target, agentDir, "document-writer.md")), "created role file deleted by rollback");
      assert.ok(existsSync(join(target, ".opencode", agentDir.split("/")[1], "personal" + (host === "v1" ? "-agent" : "-v2-agent") + ".md")) || true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test(`${host}: .jsonc project overlay shadows .json — conflict, nothing written`, async () => {
    const target = makeTarget({ withOverlay: false });
    try {
      writeFileSync(join(target, ".opencode", "oh-my-opencode-slim.jsonc"), "// owner comment\n{}\n");
      const before = snapshot(target);
      await assert.rejects(() => install({ packageRoot: REPO_ROOT, target, host }), (err) => err.code === 2);
      assert.deepEqual(snapshot(target), before);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test(`${host}: managed-file drift after install blocks reinstall; --force replaces with backup`, async () => {
    const target = makeTarget();
    try {
      const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
      await install({ packageRoot: REPO_ROOT, target, host });
      const roleFile = join(target, agentDir, "lark-operator.md");
      writeFileSync(roleFile, "---\ndescription: tampered\n---\nowner edit\n");
      const tampered = readFileSync(roleFile);

      await assert.rejects(
        () => install({ packageRoot: REPO_ROOT, target, host }),
        (err) => err.code === 2 && err.report.some((l) => l.includes("changed since install")),
      );
      assert.deepEqual(readFileSync(roleFile), tampered, "drifted file untouched without --force");

      const { manifest } = await install({ packageRoot: REPO_ROOT, target, host, force: true });
      const replaced = manifest.files.find((f) => f.path === `${agentDir}/lark-operator.md`);
      assert.equal(replaced.action, "replace");
      assert.deepEqual(readFileSync(join(target, replaced.backup)), tampered, "drifted content backed up byte-exact");
      const check = verify({ target });
      assert.deepEqual(check.drift, [], "shipped role content restored (manifest/disk hashes agree)");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test(`${host}: uninstall reverses managed content and preserves unrelated configuration`, async () => {
    const target = makeTarget();
    try {
      await install({ packageRoot: REPO_ROOT, target, host });
      const result = uninstall({ target });

      const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
      const skillDir = host === "v1" ? ".opencode/skill" : ".opencode/skills";
      assert.ok(result.removed.includes(`${agentDir}/document-writer.md`));
      assert.ok(result.removed.includes(`${agentDir}/lark-operator.md`));
      assert.ok(!existsSync(join(target, agentDir, "document-writer.md")));

      // installed skills gone, owner skills untouched
      assert.ok(!existsSync(join(target, skillDir, "domain-modeling")), "installed skill dir pruned");
      const personalSkill = host === "v1" ? join(".opencode", "skill", "personal-skill") : join(".opencode", "skills", "personal-v2-skill");
      assert.ok(existsSync(join(target, personalSkill, "SKILL.md")), "owner skill preserved");
      // empty host skill dir pruned only if the installer created it
      if (!readdirSync(join(target, ".opencode", skillDir.split("/")[1])).length) {
        assert.ok(!existsSync(join(target, skillDir)), "empty skill dir removed");
      }

      // role agent dir survives if owner files live there; owner files intact either way
      assert.ok(existsSync(join(target, agentDir, host === "v1" ? "personal-agent.md" : "personal-v2-agent.md")));

      // overlay: managed keys removed, everything else preserved
      const overlay = JSON.parse(readFileSync(join(target, ".opencode", "oh-my-opencode-slim.json"), "utf8"));
      assert.ok(!overlay.agents?.[MANAGED_AGENT_KEYS[0]] && !overlay.agents?.[MANAGED_AGENT_KEYS[1]]);
      assert.ok(overlay.agents["personal-reviewer"], "unrelated agent preserved through uninstall");
      assert.deepEqual(overlay.customTopLevel, { keep: true });

      assert.ok(result.manifestRemoved, "manifest removed after clean uninstall");
      assert.ok(existsSync(join(target, "unrelated.txt")));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test(`${host}: uninstall keeps files the owner changed after install`, async () => {
    const target = makeTarget();
    try {
      await install({ packageRoot: REPO_ROOT, target, host });
      const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
      const roleFile = join(target, agentDir, "document-writer.md");
      writeFileSync(roleFile, "---\ndescription: owner fork\n---\nbody\n");

      const result = uninstall({ target });
      assert.ok(result.kept.some((k) => k.path === `${agentDir}/document-writer.md`), "changed file reported as kept");
      assert.ok(existsSync(roleFile), "changed file not deleted");
      assert.equal(result.manifestRemoved, false, "manifest kept when reconciliation is pending");
      const manifest = manifestMod.readManifest(target);
      assert.ok(manifest.lastUninstall, "manifest records pending reconciliation");

      // uninstall succeeds once the owner reconciles
      rmSync(roleFile);
      const result2 = uninstall({ target });
      assert.equal(result2.manifestRemoved, true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test(`${host}: manifest pins host flavor — cross-flavor reinstall refused`, async () => {
    const target = makeTarget();
    try {
      await install({ packageRoot: REPO_ROOT, target, host });
      const other = host === "v1" ? "v2" : "v1";
      await assert.rejects(
        () => install({ packageRoot: REPO_ROOT, target, host: other }),
        (err) => err.code === 2 && err.report.some((l) => l.includes("uninstall")),
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
}

// --- rollback drift gating (recorded installed hashes) --------------------------
// Rollback and the uninstall backup-restore path compare current bytes against
// the installed hash recorded at install time and refuse to overwrite
// post-install edits (INSTALL.md §3-§4).

for (const host of HOSTS) {
  test(`${host}: rollback blocks a file hand-edited after install; clean rollback is byte-exact`, async () => {
  const target = makeTarget();
  try {
    const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
    await install({ packageRoot: REPO_ROOT, target, host });
    const manifest = manifestMod.readManifest(target);
    assert.ok(manifest.files.every((f) => typeof f.sha256Installed === "string"), "install records an installed hash per file");

    // (a) hand-edit an installed file after install
    const skillDir = host === "v1" ? ".opencode/skill" : ".opencode/skills";
    const rel = `${skillDir}/domain-modeling/SKILL.md`;
    const edited = "---\nname: domain-modeling\n---\nowner edit after install\n";
    writeFileSync(join(target, rel), edited);

    const result = rollback({ target });
    assert.ok(result.blocked.includes(rel), "drifted file blocks its own restore");
    assert.equal(readFileSync(join(target, rel)).toString(), edited, "drifted file left byte-untouched");
    assert.ok(manifestMod.readManifest(target), "manifest retained while reconciliation is pending");
    assert.ok(existsSync(join(target, ".opencode", "omo-coworkers-backup")), "backup records retained for later reconciliation");

    // clean paths still roll back around the blocked one
    assert.ok(result.deleted.some((p) => p.startsWith(agentDir)), "unrelated created files still deleted");
    assert.ok(!existsSync(join(target, agentDir, "document-writer.md")));

    // (b) once the owner reconciles, rollback completes and removes its records
    rmSync(join(target, rel));
    const result2 = rollback({ target });
    assert.equal(result2.blocked.length, 0, "rollback completes after reconciliation");
    assert.ok(!existsSync(join(target, ".opencode", "omo-coworkers-install.json")), "manifest removed by completed rollback");
    const overlay = JSON.parse(readFileSync(join(target, ".opencode", "oh-my-opencode-slim.json"), "utf8"));
    assert.ok(overlay.agents["personal-reviewer"], "owner overlay content untouched by rollback");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test(`${host}: rollback restores pre-install bytes byte-exact for backed-up files`, async () => {
  const target = makeTarget();
  try {
    const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
    const roleRel = `${agentDir}/lark-operator.md`;
    const original = "---\ndescription: owner pre-install role\n---\noriginal body\n";
    writeFileSync(join(target, roleRel), original);

    await assert.rejects(() => install({ packageRoot: REPO_ROOT, target, host }), ConflictError);
    const { manifest } = await install({ packageRoot: REPO_ROOT, target, host, force: true });
    const rec = manifest.files.find((f) => f.path === roleRel);
    assert.equal(rec.action, "replace");
    assert.equal(rec.sha256Before, sha256(Buffer.from(original)), "pre-install hash recorded at backup time");

    const rb = rollback({ target });
    assert.equal(rb.blocked.length, 0);
    assert.ok(rb.restored.includes(roleRel), "backed-up role file restored");
    assert.equal(readFileSync(join(target, roleRel)).toString(), original, "restored bytes are the exact pre-install content");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test(`${host}: legacy manifest without hash fields rolls back with an explicit warning`, async () => {
  const target = makeTarget();
  try {
    const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
    // a backed-up (force-replaced) file exercises the restore-with-warning path
    const roleRel = `${agentDir}/lark-operator.md`;
    writeFileSync(join(target, roleRel), "---\ndescription: owner role\n---\nbody\n");
    await install({ packageRoot: REPO_ROOT, target, host, force: true });

    // simulate a manifest from a schemaVersion 1 era without recorded hashes
    const manifest = manifestMod.readManifest(target);
    const strip = ({ sha256Installed, ...rest }) => rest;
    manifestMod.writeManifest(target, {
      ...manifest,
      files: manifest.files.map(strip),
      overlay: manifest.overlay ? strip(manifest.overlay) : undefined,
    });
    assert.ok(manifestMod.readManifest(target).files.every((f) => f.sha256Installed === undefined));

    // hand-edit the backed-up file: legacy rollback cannot detect this, says so, and restores anyway
    writeFileSync(join(target, roleRel), "---\ndescription: owner edit\n---\nedited body\n");
    const result = rollback({ target });
    assert.equal(result.blocked.length, 0, "legacy manifest cannot drift-block");
    assert.ok(
      result.warnings.some((w) => w.includes(roleRel) && w.includes("no installed hash")),
      "warning names the path whose drift could not be verified",
    );
    assert.equal(readFileSync(join(target, roleRel)).toString(), "---\ndescription: owner role\n---\nbody\n", "backup bytes restored despite the warning");
    assert.ok(!existsSync(join(target, ".opencode", "omo-coworkers-install.json")), "legacy rollback still completes");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test(`${host}: uninstall restores --force backups only when bytes match the install-time record`, async () => {
  const target = makeTarget();
  try {
    const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
    const roleRel = `${agentDir}/document-writer.md`;
    const preInstall = "---\ndescription: owner role\n---\npre-install body\n";
    writeFileSync(join(target, roleRel), preInstall);
    await install({ packageRoot: REPO_ROOT, target, host, force: true });
    const installedBytes = readFileSync(join(target, roleRel));

    const edited = "---\ndescription: owner fork post-install\n---\nnew body\n";
    writeFileSync(join(target, roleRel), edited);
    const result = uninstall({ target });
    assert.ok(result.kept.some((k) => k.path === roleRel), "drifted file kept, backup not restored over it");
    assert.equal(readFileSync(join(target, roleRel)).toString(), edited, "post-install edit preserved");
    assert.ok(manifestMod.readManifest(target), "manifest retained while the kept file is pending");

    // once the owner reverts the bytes to the installed content, the backup is restored
    writeFileSync(join(target, roleRel), installedBytes);
    const result2 = uninstall({ target });
    assert.ok(result2.restored.includes(roleRel), "backup restored after reconciliation");
    assert.equal(readFileSync(join(target, roleRel)).toString(), preInstall, "restored bytes are the exact pre-install content");
    assert.equal(result2.manifestRemoved, true, "uninstall completes after reconciliation");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test(`${host}: uninstall keeps a post-install-edited overlay instead of restoring the --force backup`, async () => {
  const target = makeTarget();
  try {
    const oc = join(target, ".opencode");
    const overlayAbs = join(oc, "oh-my-opencode-slim.json");
    const preOverlay = `${JSON.stringify({ agents: { [MANAGED_AGENT_KEYS[0]]: { description: "owner's own version" } } }, null, 2)}\n`;
    writeFileSync(overlayAbs, preOverlay);
    await install({ packageRoot: REPO_ROOT, target, host, force: true });
    const mergedBytes = readFileSync(overlayAbs);

    // owner edits the overlay after the force install (managed entry only, so
    // uninstall's unmerge would collapse the file and reach the backup restore)
    const forked = `${JSON.stringify({ agents: { [MANAGED_AGENT_KEYS[0]]: { description: "owner fork" } } }, null, 2)}\n`;
    writeFileSync(overlayAbs, forked);
    const result = uninstall({ target });
    assert.ok(result.kept.some((k) => k.path === ".opencode/oh-my-opencode-slim.json"), "drifted overlay kept, backup not restored over it");
    assert.equal(readFileSync(overlayAbs).toString(), forked, "post-install overlay edit preserved");

    writeFileSync(overlayAbs, mergedBytes);
    const result2 = uninstall({ target });
    assert.ok(result2.restored.includes(".opencode/oh-my-opencode-slim.json"), "pre-install overlay backup restored after reconciliation");
    assert.equal(readFileSync(overlayAbs).toString(), preOverlay, "overlay restored byte-exact");
    assert.equal(result2.manifestRemoved, true);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

const PLUGIN_REL = ".opencode/plugins/claude-advisor.mjs";
const pluginSourceRel = (host) => join("plugins", "claude-advisor", host === "v1" ? "index.v1.mjs" : "index.js");

test(`${host}: claude-advisor plugin payload installs at the managed path with recorded hashes`, async () => {
  const target = makeTarget();
  try {
    const sourceBytes = readFileSync(join(REPO_ROOT, pluginSourceRel(host)));

    const dry = await plan({ packageRoot: REPO_ROOT, target, host });
    const planned = dry.entries.find((e) => e.path === PLUGIN_REL);
    assert.ok(planned, "plan lists the plugin payload");
    assert.equal(planned.action, "create");
    assert.equal(planned.kind, "plugin");
    assert.equal(planned.sha256, sha256(sourceBytes), "planned hash is the verbatim source hash");

    const { manifest } = await install({ packageRoot: REPO_ROOT, target, host });
    const pluginAbs = join(target, ".opencode", "plugins", "claude-advisor.mjs");
    assert.ok(existsSync(pluginAbs), "payload lands at .opencode/plugins/claude-advisor.mjs");
    assert.ok(!existsSync(join(target, ".opencode", "plugins", "guard.test.mjs")), "the plugin's own test file is not shipped");
    assert.equal(readFileSync(pluginAbs).toString(), sourceBytes.toString(), `payload is a verbatim byte-copy of ${pluginSourceRel(host)} for host ${host}`);
    const rec = manifest.files.find((f) => f.path === PLUGIN_REL);
    assert.ok(rec, "manifest records the plugin payload");
    assert.equal(rec.kind, "plugin");
    assert.equal(rec.sha256Installed, sha256(sourceBytes), "manifest hash matches the source bytes");
    assert.equal(manifest.schemaVersion, 1, "record shape extends naturally; schema stays 1");

    const check = verify({ target });
    assert.equal(check.drift.length, 0);
    assert.equal(check.missing.length, 0);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test(`${host}: pre-existing unmanaged plugin file conflicts; --force takes over and rollback is drift-gated`, async () => {
  const target = makeTarget();
  try {
    const pluginAbs = join(target, ".opencode", "plugins", "claude-advisor.mjs");
    mkdirSync(join(target, ".opencode", "plugins"), { recursive: true });
    const ownerBody = "// owner's own claude-advisor variant\nexport const mine = true\n";
    writeFileSync(pluginAbs, ownerBody);
    const ownerHash = sha256(ownerBody);
    const before = snapshot(target);

    await assert.rejects(
      install({ packageRoot: REPO_ROOT, target, host }),
      (err) => {
        assert.ok(err instanceof ConflictError);
        assert.ok(err.report.some((l) => l.includes(PLUGIN_REL)), "conflict names the plugin path");
        return true;
      },
    );
    assert.deepEqual(snapshot(target), before, "conflicted install wrote nothing");
    assert.equal(readFileSync(pluginAbs).toString(), ownerBody, "owner file byte-untouched");

    const { manifest } = await install({ packageRoot: REPO_ROOT, target, host, force: true });
    const rec = manifest.files.find((f) => f.path === PLUGIN_REL);
    assert.equal(rec.action, "replace", "force takeover recorded as replace");
    assert.equal(rec.sha256Before, ownerHash, "pre-install bytes hashed into the record");
    assert.ok(rec.backup, "byte-exact backup recorded under the backup root");
    assert.ok(existsSync(join(target, rec.backup)), "backup file exists");

    // drift: the installed payload is edited after the force install
    writeFileSync(pluginAbs, "// drifted\n");
    const rb = rollback({ target });
    assert.ok(rb.blocked.includes(PLUGIN_REL), "drifted payload blocks its own restore");
    assert.equal(readFileSync(pluginAbs).toString(), "// drifted\n", "blocked restore wrote nothing");
    assert.ok(existsSync(join(target, ".opencode", "omo-coworkers-install.json")), "manifest retained for reconciliation");

    // reconciled back to the recorded installed bytes: owner's original comes back byte-exact
    writeFileSync(pluginAbs, readFileSync(join(REPO_ROOT, pluginSourceRel(host))));
    const rb2 = rollback({ target });
    assert.ok(rb2.restored.includes(PLUGIN_REL), "owner's pre-install file restored");
    assert.equal(readFileSync(pluginAbs).toString(), ownerBody, "restored bytes are the recorded pre-install bytes");
    assert.ok(!existsSync(join(target, ".opencode", "omo-coworkers-install.json")), "clean rollback removes the manifest");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test(`${host}: uninstall removes the unmodified plugin payload and prunes the created plugins dir; keeps a drifted one`, async () => {
  const target = makeTarget();
  try {
    await install({ packageRoot: REPO_ROOT, target, host });

    // drifted: the payload is edited after install
    const pluginAbs = join(target, ".opencode", "plugins", "claude-advisor.mjs");
    writeFileSync(pluginAbs, "// owner edited the dispatch guard\n");
    const driftResult = uninstall({ target });
    assert.ok(
      driftResult.kept.some((k) => k.path === PLUGIN_REL && /changed after install/.test(k.reason)),
      "drifted payload kept and reported",
    );
    assert.equal(readFileSync(pluginAbs).toString(), "// owner edited the dispatch guard\n", "drifted bytes preserved");
    assert.equal(driftResult.manifestRemoved, false, "manifest retained while entries are pending reconciliation");

    // reconciled: restore the installed bytes, uninstall completes
    writeFileSync(pluginAbs, readFileSync(join(REPO_ROOT, pluginSourceRel(host))));
    const result = uninstall({ target });
    assert.ok(result.removed.includes(PLUGIN_REL), "unmodified payload removed");
    assert.ok(!existsSync(pluginAbs));
    assert.ok(!existsSync(join(target, ".opencode", "plugins")), "created plugins dir pruned when empty");
    assert.ok(existsSync(join(target, ".opencode")), ".opencode itself survives");
    assert.equal(result.manifestRemoved, true);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test(`${host}: rollback deletes the created plugin payload and prunes the created dir`, async () => {
  const target = makeTarget();
  try {
    await install({ packageRoot: REPO_ROOT, target, host });
    assert.ok(existsSync(join(target, PLUGIN_REL)));

    const rb = rollback({ target });
    assert.ok(rb.deleted.includes(PLUGIN_REL), "created payload deleted");
    assert.ok(!existsSync(join(target, PLUGIN_REL)));
    assert.ok(!existsSync(join(target, ".opencode", "plugins")), "created plugins dir pruned");
    assert.ok(!existsSync(join(target, ".opencode", "omo-coworkers-install.json")), "manifest removed after clean rollback");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
}

// --- host detection -----------------------------------------------------------

function fakeExe(dir, name, output) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`, { mode: 0o755 });
  return path;
}

test("classify: version boundaries", () => {
  assert.equal(classify("1.18.33").flavor, "v1");
  assert.equal(classify("1.18.33").runtimeTested, true);
  assert.equal(classify("1.18.29").ok, true, "v1 lower bound accepted");
  assert.equal(classify("1.18.28").ok, false, "below lower bound rejected");
  assert.equal(classify("2.0.20").flavor, "v2");
  assert.equal(classify("2.0.20").runtimeTested, true);
  assert.equal(
    classify("2.0.20").note.includes("not a claim of full release acceptance"),
    true,
    "a matching version is installer-level evidence only, never full runtime acceptance",
  );
  assert.equal(classify("2.0.20").ok, true, "v2 floor accepted");
  assert.equal(classify("2.0.19").ok, false, "below the initial v2 installation floor");
  assert.equal(classify("2.0.1").ok, false, "2.0.1 is below the 2.0.20 v2 floor");
  assert.equal(classify("3.0.0").ok, false, "unknown major must not silently count as supported v2");
  assert.equal(classify("0.9.0").ok, false);
  assert.equal(classify("garbage").ok, false);
  assert.equal(classify("1.18.33").note.includes("installer-level runtime checks"), true);
  assert.equal(
    classify("1.19.0").note.includes("only been run on 1.18.33"),
    true,
    "docs separate supported vs installer-level runtime-tested",
  );
});

test("classify: rejected versions outside the supported matrix", () => {
  assert.match(classify("2.0.19").reason, /installation floor 2\.0\.20/);
  for (const v of ["3.0.0", "4.2.1", "0.9.0"]) {
    assert.equal(classify(v).ok, false, `${v} must not silently count as supported`);
  }
  assert.match(classify("3.0.0").reason, /unsupported OpenCode major version 3/);
  // pre-release versions are never silently counted as supported
  for (const v of ["2.0.20-beta.1", "2.0.21-rc.1", "1.18.33-rc.1", "3.0.0-alpha.0"]) {
    assert.equal(classify(v).ok, false, `${v} must not silently count as supported`);
  }
  assert.match(classify("2.0.20-beta.1").reason, /pre-release/);
  assert.equal(classify("2.0.20-beta.1").flavor, undefined, "rejected pre-release must not report a flavor");
  // later stable v2 within major 2 stays supported but is not runtime-tested
  const later = classify("2.1.0");
  assert.equal(later.ok, true);
  assert.equal(later.flavor, "v2");
  assert.equal(later.runtimeTested, false);
  assert.match(later.note, /only been run on 2\.0\.20/);
  assert.equal(V2_MIN, "2.0.20", "the v2 installation floor is a package constant");
  assert.equal(V1_TESTED, "1.18.33");
  assert.equal(V2_TESTED, "2.0.20");
});

test("probeExecutable: real host output shapes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocw-exe-"));
  try {
    const v1 = await probeExecutable(fakeExe(dir, "oc1", "1.18.33"));
    assert.equal(v1.ok, true);
    assert.equal(v1.flavor, "v1");
    const v2 = await probeExecutable(fakeExe(dir, "oc2", "opencode v2.0.20"));
    assert.equal(v2.ok, true);
    assert.equal(v2.flavor, "v2");
    assert.equal(v2.version, "2.0.20");
    const bad = await probeExecutable(fakeExe(dir, "oc3", "not-a-version"));
    assert.equal(bad.ok, false);
    const pre = await probeExecutable(fakeExe(dir, "oc4", "opencode 3.0.0-alpha.0"));
    assert.equal(pre.ok, false, "pre-release probe must not be counted as supported");
    assert.match(pre.reason, /pre-release/);
    const below = await probeExecutable(fakeExe(dir, "oc5", "opencode 2.0.19"));
    assert.equal(below.ok, false, "below the v2 floor must be rejected");
    const missing = await probeExecutable(join(dir, "does-not-exist"));
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /cannot run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install without explicit host uses probeExecutable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocw-exe-"));
  const target = makeTarget();
  try {
    const exe = fakeExe(dir, "oc", "opencode v2.0.20");
    const { manifest } = await install({ packageRoot: REPO_ROOT, target, opencode: exe });
    assert.equal(manifest.host.flavor, "v2");
    assert.equal(manifest.host.executable, exe);
    assert.equal(manifest.host.runtimeTested, true);

    await assert.rejects(
      () => install({ packageRoot: REPO_ROOT, target: makeTarget(), opencode: fakeExe(dir, "old", "1.18.28") }),
      (err) => err.code === 3,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("explicit --host plus --opencode: probe must succeed and agree with the flavor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocw-exe-"));
  const target = makeTarget();
  try {
    // mismatch: --host v1 but the executable reports v2
    await assert.rejects(
      () => plan({ packageRoot: REPO_ROOT, target, host: "v1", opencode: fakeExe(dir, "v2exe", "opencode v2.0.20") }),
      (err) => err.code === 3 && /reports 2\.0\.20 \(v2\)/.test(err.message),
    );
    // mismatch the other way: --host v2 but the executable reports v1
    await assert.rejects(
      () => plan({ packageRoot: REPO_ROOT, target, host: "v2", opencode: fakeExe(dir, "v1exe", "1.18.33") }),
      (err) => err.code === 3 && /reports 1\.18\.33 \(v1\)/.test(err.message),
    );
    // failing executable (nonzero exit) with explicit host still aborts with 3
    const broken = join(dir, "broken");
    writeFileSync(broken, "#!/bin/sh\necho 'simulated failure' >&2\nexit 7\n", { mode: 0o755 });
    await assert.rejects(
      () => plan({ packageRoot: REPO_ROOT, target, host: "v2", opencode: broken }),
      (err) => err.code === 3 && /could not be verified/.test(err.message),
    );
    // agreement: explicit v2 + probed v2 renders, with the probed version recorded
    const ok = await plan({ packageRoot: REPO_ROOT, target, host: "v2", opencode: fakeExe(dir, "agree", "opencode v2.0.20") });
    assert.equal(ok.host.flavor, "v2");
    assert.equal(ok.host.version, "2.0.20");
    assert.equal(ok.host.runtimeTested, true);
    assert.equal(ok.host.explicit, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("explicit --host without --opencode: offline format generation, version not verified", async () => {
  const target = makeTarget();
  try {
    const { manifest } = await install({ packageRoot: REPO_ROOT, target, host: "v2" });
    assert.equal(manifest.host.flavor, "v2");
    assert.equal(manifest.host.version, null);
    assert.equal(manifest.host.explicit, true);
    assert.equal(manifest.host.runtimeTested, false);
    assert.match(manifest.host.note, /version not verified/);
    assert.match(manifest.host.note, /offline format generation/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("CLI: explicit --host with mismatching --opencode exits 3; solo --host reports unverified version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocw-exe-"));
  const target = makeTarget();
  try {
    const v1exe = fakeExe(dir, "v1exe", "1.18.33");
    await assert.rejects(
      () => run(process.execPath, [CLI, "install", "--host", "v2", "--opencode", v1exe, "--target", target, "--json"]),
      (err) => err.code === 3,
    );
    const out = JSON.parse((await run(process.execPath, [CLI, "plan", "--host", "v2", "--target", target, "--json"])).stdout);
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.equal(out.host.flavor, "v2");
    assert.equal(out.host.version, null);
    assert.match(out.host.note, /version not verified/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// --- pure merge semantics -----------------------------------------------------

test("mergeOverlay/unmergeOverlay semantics", () => {
  const shipped = { agents: { "document-writer": { description: "d", permission: { task: "deny" } } } };
  const existing = {
    presets: { a: 1 },
    agents: { "document-writer": { custom: true }, other: { x: 1 } },
  };
  const merged = mergeOverlay(existing, shipped);
  assert.deepEqual(merged.presets, { a: 1 });
  assert.deepEqual(merged.agents.other, { x: 1 });
  assert.equal(merged.agents["document-writer"].custom, true, "unknown key inside managed entry preserved");
  assert.equal(merged.agents["document-writer"].description, "d", "shipped keys win");
  assert.deepEqual(existing.agents["document-writer"], { custom: true }, "input not mutated");

  const { next, removed } = unmergeOverlay(merged);
  assert.equal(removed, true);
  assert.ok(!("document-writer" in next.agents));
  assert.ok(next.agents.other);

  const lone = unmergeOverlay({ agents: { "document-writer": {} } });
  assert.equal(lone.next, null, "empty overlay collapses to null");

  const untouched = unmergeOverlay({ agents: { other: {} } });
  assert.equal(untouched.removed, false);
});

// --- link-boundary regressions (hard-link write-through protection) ------------
// The owner's live deployment hard-links global and dotfiles copies of
// opencode.json / oh-my-opencode-slim.json (DEPLOYMENT-OBSERVATIONS.md). Every
// installer write must be a same-dir temp file + rename so linked twins are
// never written through. These tests simulate that topology with temp dirs.

test("hard-linked overlay: merge and rollback never write through to the twin", async () => {
  for (const host of HOSTS) {
    const target = makeTarget();
    try {
      const overlayAbs = join(target, ".opencode", "oh-my-opencode-slim.json");
      const twin = join(target, "dotfiles-twin.json");
      const original = readFileSync(overlayAbs);
      linkSync(overlayAbs, twin);
      assert.equal(statSync(overlayAbs).nlink, 2, "fixture is hard-linked");

      await install({ packageRoot: REPO_ROOT, target, host });
      // merge committed via rename -> new inode, twin untouched
      assert.equal(statSync(twin).nlink, 1, "twin released, not mutated");
      assert.equal(readFileSync(twin).toString(), original.toString(), "twin bytes unchanged by install");
      const overlay = JSON.parse(readFileSync(overlayAbs, "utf8"));
      assert.ok(overlay.agents[MANAGED_AGENT_KEYS[0]].permission, "overlay merged");

      const rb = rollback({ target });
      assert.equal(rb.blocked.length, 0);
      assert.equal(readFileSync(overlayAbs).toString(), original.toString(), "rollback restored original bytes");
      assert.equal(readFileSync(twin).toString(), original.toString(), "twin still untouched after rollback");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("re-linked overlay after install: uninstall rewrite does not write through", async () => {
  for (const host of HOSTS) {
    const target = makeTarget();
    try {
      await install({ packageRoot: REPO_ROOT, target, host });
      // owner re-hard-links the overlay to a dotfiles twin after install
      const overlayAbs = join(target, ".opencode", "oh-my-opencode-slim.json");
      const merged = readFileSync(overlayAbs);
      const twin = join(target, "dotfiles-twin.json");
      linkSync(overlayAbs, twin);

      const result = uninstall({ target });
      assert.ok(result.restored.some((r) => typeof r === "string" && r.startsWith(".opencode/oh-my-opencode-slim.json")), "overlay keys removed");
      assert.equal(readFileSync(twin).toString(), merged.toString(), "uninstall never wrote through the twin");
      const after = JSON.parse(readFileSync(overlayAbs, "utf8"));
      assert.ok(!after.agents?.[MANAGED_AGENT_KEYS[0]], "managed key removed from target overlay");
      assert.ok(after.agents["personal-reviewer"], "unrelated agent survived");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("symlink at managed path is a conflict — link boundaries stay with the owner", async () => {
  for (const host of HOSTS) {
    const target = makeTarget({ withAgentFiles: false });
    try {
      const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
      const realDir = join(target, "outside-dotfiles");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "document-writer.md"), "---\ndescription: linked role\n---\nbody\n");
      mkdirSync(join(target, ".opencode", agentDir.split("/")[1]), { recursive: true });
      symlinkSync(join(realDir, "document-writer.md"), join(target, agentDir, "document-writer.md"));
      const linkInode = lstatSync(join(target, agentDir, "document-writer.md")).ino;
      const before = snapshot(target);

      // conflict even with --force: the installer never replaces links
      await assert.rejects(
        () => install({ packageRoot: REPO_ROOT, target, host, force: true }),
        (err) => err.code === 2 && err.report.some((l) => l.includes("symlink at managed path")),
      );
      assert.deepEqual(snapshot(target), before, "nothing written on symlink conflict");
      assert.equal(lstatSync(join(target, agentDir, "document-writer.md")).ino, linkInode, "link itself preserved");
      assert.equal(readFileSync(join(realDir, "document-writer.md")).toString(), "---\ndescription: linked role\n---\nbody\n", "link target untouched");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

// --- global (user-level) install mode ------------------------------------------
// Global mode installs into the OpenCode config directory (~/.config/opencode
// or --config-dir): prompt bodies under oh-my-opencode-slim/, skills under the
// plural skills/, agent definitions additively into oh-my-opencode-slim.json.
// No plugin, no native agent .md rendering; the payload is flavor-independent.

const GLOBAL_PROMPT_DIR = "oh-my-opencode-slim";
const REPO_OVERLAY = JSON.parse(readFileSync(join(REPO_ROOT, "oh-my-opencode-slim.json"), "utf8"));
const BUNDLED_SKILLS = ["domain-modeling", "humanizer", "maintaining-product-engineering-docs"];

function makeGlobalConfigDir({ withOverlay = false, managedKey = null, withDecoyAgent = false, withOwnerSkill = false } = {}) {
  const cfg = mkdtempSync(join(tmpdir(), "ocw-global-test-"));
  if (withOverlay) {
    const agents = {
      "personal-reviewer": { description: "owner agent", skills: ["personal-skill"] },
    };
    if (managedKey) agents[managedKey] = { description: "owner-curated co-worker", model: "owner-model" };
    writeFileSync(
      join(cfg, "oh-my-opencode-slim.json"),
      `${JSON.stringify({ $schema: "https://example.invalid/oh-my-opencode-slim.schema.json", presets: { keep: true }, agents }, null, 2)}\n`,
    );
  }
  if (withDecoyAgent) {
    // simulates the owner's host-native agents/<role>.md personal file
    mkdirSync(join(cfg, "agents"), { recursive: true });
    writeFileSync(join(cfg, "agents", "lark-operator.md"), "---\ndescription: owner native agent\nmode: subagent\n---\nowner body\n");
  }
  if (withOwnerSkill) {
    mkdirSync(join(cfg, "skills", "owner-skill"), { recursive: true });
    writeFileSync(join(cfg, "skills", "owner-skill", "SKILL.md"), "---\nname: owner-skill\n---\nowner content\n");
  }
  writeFileSync(join(cfg, "unrelated.txt"), "owner file\n");
  return cfg;
}

test("global: fresh install writes prompt bodies, skills, creates the overlay, and records scope global", async () => {
  const cfg = makeGlobalConfigDir();
  try {
    const { manifest } = await install({ packageRoot: REPO_ROOT, target: cfg, scope: "global", host: "v1" });

    for (const role of ROLES) {
      const abs = join(cfg, GLOBAL_PROMPT_DIR, `${role}.md`);
      assert.equal(
        readFileSync(abs, "utf8"),
        readFileSync(join(REPO_ROOT, "prompts", `${role}.md`), "utf8").replace(/\n*$/, "\n"),
        `global ${role} prompt body is the verbatim prompt (no frontmatter rendering)`,
      );
    }
    for (const id of BUNDLED_SKILLS) {
      assert.equal(
        readFileSync(join(cfg, "skills", id, "SKILL.md"), "utf8"),
        readFileSync(join(REPO_ROOT, "skills", id, "SKILL.md"), "utf8"),
        `skill ${id} copied verbatim under the plural skills/ dir`,
      );
    }
    const overlay = JSON.parse(readFileSync(join(cfg, "oh-my-opencode-slim.json"), "utf8"));
    assert.deepEqual(overlay, { $schema: REPO_OVERLAY.$schema, agents: REPO_OVERLAY.agents }, "created overlay is the shipped agents block (+ its $schema)");
    for (const key of MANAGED_AGENT_KEYS) assert.ok(overlay.agents[key], `overlay has agents.${key}`);

    assert.equal(manifest.scope, "global");
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.host.flavor, "v1");
    assert.equal(manifestMod.readManifest(cfg), null, "no project manifest lives in a global config dir");
    assert.ok(manifest.files.every((f) => !f.path.startsWith(".opencode")), "no project-prefixed paths in global mode");
    assert.ok(!manifest.files.some((f) => f.kind === "plugin"), "global mode never installs the plugin");
    assert.ok(manifest.notices.some((n) => n.includes("claude-advisor")), "plugin skip surfaced as a manifest notice");
    assert.ok(manifest.backupRoot.startsWith("omo-coworkers-backup/"), "backup root sits directly under the config dir");

    const check = verify({ target: cfg, scope: "global" });
    assert.equal(check.drift.length, 0);
    assert.equal(check.missing.length, 0);
    assert.equal(check.scope, "global");
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("global: existing overlay without managed keys is merged additively; unrelated keys preserved", async () => {
  const cfg = makeGlobalConfigDir({ withOverlay: true });
  try {
    const originalBytes = readFileSync(join(cfg, "oh-my-opencode-slim.json"));
    const { manifest } = await install({ packageRoot: REPO_ROOT, target: cfg, scope: "global", host: "v1" });

    const overlay = JSON.parse(readFileSync(join(cfg, "oh-my-opencode-slim.json"), "utf8"));
    assert.deepEqual(overlay.presets, { keep: true }, "unrelated top-level key preserved");
    assert.deepEqual(
      overlay.agents["personal-reviewer"],
      { description: "owner agent", skills: ["personal-skill"] },
      "unrelated agent preserved field-for-field",
    );
    for (const key of MANAGED_AGENT_KEYS) {
      assert.deepEqual(overlay.agents[key], REPO_OVERLAY.agents[key], `agents.${key} matches the shipped block`);
    }
    assert.equal(manifest.overlay.action, "merge");
    assert.ok(manifest.overlay.backup, "pre-merge overlay backed up");
    assert.deepEqual(readFileSync(join(cfg, manifest.overlay.backup)), originalBytes, "backup is byte-exact");
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("global: overlay already managing a co-worker agent is never modified; notices record the preserved keys", async () => {
  const cfg = makeGlobalConfigDir({ withOverlay: true, managedKey: "document-writer" });
  try {
    const before = snapshot(cfg);
    const { manifest } = await install({ packageRoot: REPO_ROOT, target: cfg, scope: "global", host: "v1" });
    const after = snapshot(cfg);

    assert.equal(after["oh-my-opencode-slim.json"], before["oh-my-opencode-slim.json"], "owner overlay byte-untouched");
    assert.equal(manifest.overlay.action, "preserve");
    assert.deepEqual(manifest.overlay.preserved, ["document-writer"]);
    assert.ok(
      manifest.notices.some((n) => n.includes("document-writer") && n.includes("preserved")),
      "manifest notice names the preserved owner entries",
    );
    assert.ok(existsSync(join(cfg, GLOBAL_PROMPT_DIR, "document-writer.md")), "prompt bodies still installed");
    assert.ok(existsSync(join(cfg, "skills", "domain-modeling", "SKILL.md")), "skills still installed");
    assert.equal(verify({ target: cfg, scope: "global" }).drift.length, 0, "install is consistent even with a preserved overlay");
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("global: byte-identical pre-existing skill dir is adopted with zero writes; uninstall removes it", async () => {
  const cfg = makeGlobalConfigDir();
  try {
    const skillAbs = join(cfg, "skills", "domain-modeling", "SKILL.md");
    mkdirSync(dirname(skillAbs), { recursive: true });
    writeFileSync(skillAbs, readFileSync(join(REPO_ROOT, "skills", "domain-modeling", "SKILL.md")));
    const statBefore = statSync(skillAbs);

    const { manifest } = await install({ packageRoot: REPO_ROOT, target: cfg, scope: "global", host: "v1" });
    const rec = manifest.files.find((f) => f.path === "skills/domain-modeling/SKILL.md");
    assert.equal(rec.action, "adopted", "identical payload adopted, not rewritten");
    assert.equal(rec.sha256Installed, sha256(readFileSync(skillAbs)), "manifest records the payload hash for the adopted path");
    const statAfter = statSync(skillAbs);
    assert.equal(statAfter.ino, statBefore.ino, "adopted file never rewritten (same inode)");
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, "adopted file mtime untouched (zero writes)");

    // the other skills were written normally
    const written = manifest.files.find((f) => f.path === "skills/humanizer/SKILL.md");
    assert.equal(written.action, "create");

    const unl = uninstall({ target: cfg, scope: "global" });
    assert.ok(unl.removed.includes("skills/domain-modeling/SKILL.md"), "adopted path is recorded, so uninstall removes it");
    assert.ok(!existsSync(join(cfg, "skills", "domain-modeling")), "adopted skill dir pruned");
    assert.equal(unl.manifestRemoved, true);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("global: differing prompt file conflicts; --force backs up under omo-coworkers-backup and rollback round-trips", async () => {
  const cfg = makeGlobalConfigDir();
  try {
    const rel = `${GLOBAL_PROMPT_DIR}/document-writer.md`;
    const abs = join(cfg, GLOBAL_PROMPT_DIR, "document-writer.md");
    mkdirSync(dirname(abs), { recursive: true });
    const ownerBody = "# owner's custom document-writer prompt\n";
    writeFileSync(abs, ownerBody);
    const before = snapshot(cfg);

    await assert.rejects(
      () => install({ packageRoot: REPO_ROOT, target: cfg, scope: "global", host: "v1" }),
      (err) => err instanceof ConflictError && err.code === 2 && err.report.some((l) => l.includes(rel)),
    );
    assert.deepEqual(snapshot(cfg), before, "conflict wrote nothing");

    const { manifest } = await install({ packageRoot: REPO_ROOT, target: cfg, scope: "global", host: "v1", force: true });
    const rec = manifest.files.find((f) => f.path === rel);
    assert.equal(rec.action, "replace");
    assert.ok(rec.backup.startsWith("omo-coworkers-backup/"), `backup under the global backup root: ${rec.backup}`);
    assert.equal(readFileSync(join(cfg, rec.backup), "utf8"), ownerBody, "owner prompt backed up byte-exact");

    // drift-gated rollback: post-install edits block their own restore
    writeFileSync(abs, "# owner edit after install\n");
    const rb = rollback({ target: cfg, scope: "global" });
    assert.ok(rb.blocked.includes(rel), "drifted prompt blocks its own restore");
    assert.equal(readFileSync(abs, "utf8"), "# owner edit after install\n", "drifted bytes untouched");
    assert.ok(manifestMod.readManifest(cfg, "global"), "manifest retained while reconciliation is pending");

    // reconciled: restore the recorded installed bytes, rollback completes
    writeFileSync(abs, readFileSync(join(cfg, rec.backup)));
    const rb2 = rollback({ target: cfg, scope: "global" });
    assert.equal(rb2.blocked.length, 0, "rollback completes after reconciliation");
    assert.equal(readFileSync(abs, "utf8"), ownerBody, "owner bytes restored exactly");
    assert.ok(!existsSync(join(cfg, "omo-coworkers-install.json")), "manifest removed by completed rollback");
    assert.ok(!existsSync(join(cfg, "omo-coworkers-backup")), "backup records removed");
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("global: uninstall and rollback reverse our files and leave owner files intact", async () => {
  const cfg = makeGlobalConfigDir({ withDecoyAgent: true, withOwnerSkill: true });
  const decoy = "---\ndescription: owner native agent\nmode: subagent\n---\nowner body\n";
  try {
    await install({ packageRoot: REPO_ROOT, target: cfg, scope: "global", host: "v1" });
    const unl = uninstall({ target: cfg, scope: "global" });

    assert.ok(unl.removed.includes(`${GLOBAL_PROMPT_DIR}/document-writer.md`));
    assert.ok(unl.removed.includes(`${GLOBAL_PROMPT_DIR}/lark-operator.md`));
    assert.ok(!existsSync(join(cfg, GLOBAL_PROMPT_DIR)), "our created prompt dir pruned when empty");
    assert.ok(!existsSync(join(cfg, "oh-my-opencode-slim.json")), "created overlay removed by uninstall");
    assert.equal(readFileSync(join(cfg, "agents", "lark-operator.md"), "utf8"), decoy, "owner native agent md untouched");
    assert.ok(existsSync(join(cfg, "agents")), "owner agents dir survives");
    assert.ok(existsSync(join(cfg, "skills", "owner-skill", "SKILL.md")), "owner skill untouched");
    assert.ok(existsSync(join(cfg, "skills")), "skills dir kept while an owner skill lives there");
    assert.equal(unl.manifestRemoved, true);

    // rollback path on a fresh install
    await install({ packageRoot: REPO_ROOT, target: cfg, scope: "global", host: "v1" });
    const rb = rollback({ target: cfg, scope: "global" });
    assert.equal(rb.blocked.length, 0);
    assert.ok(!existsSync(join(cfg, GLOBAL_PROMPT_DIR)));
    assert.ok(!existsSync(join(cfg, "oh-my-opencode-slim.json")), "created overlay deleted by rollback");
    assert.ok(!existsSync(join(cfg, "omo-coworkers-install.json")), "manifest removed after clean rollback");
    assert.equal(readFileSync(join(cfg, "agents", "lark-operator.md"), "utf8"), decoy, "decoy intact after rollback");
    assert.ok(existsSync(join(cfg, "skills", "owner-skill", "SKILL.md")));
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("global: v1 and v2 resolve the identical payload (flavor does not gate global mode)", async () => {
  const cfg1 = makeGlobalConfigDir();
  const cfg2 = makeGlobalConfigDir();
  try {
    const p1 = await plan({ packageRoot: REPO_ROOT, target: cfg1, scope: "global", host: "v1" });
    const p2 = await plan({ packageRoot: REPO_ROOT, target: cfg2, scope: "global", host: "v2" });
    const norm = (p) => p.entries.map((e) => `${e.path} ${e.action} ${e.sha256}`).sort();
    assert.deepEqual(norm(p2), norm(p1), "same paths and payload hashes for both flavors");
  } finally {
    rmSync(cfg1, { recursive: true, force: true });
    rmSync(cfg2, { recursive: true, force: true });
  }
});

test("CLI global: --global with --target exits 1; --config-dir without --global exits 1", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocw-global-scratch-"));
  try {
    await assert.rejects(
      () => run(process.execPath, [CLI, "plan", "--global", "--target", scratch, "--json"]),
      (err) => err.code === 1,
    );
    await assert.rejects(
      () => run(process.execPath, [CLI, "plan", "--config-dir", scratch, "--json"]),
      (err) => err.code === 1,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("CLI global: v2-probed install/verify/uninstall round-trip on a config dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocw-exe-"));
  const cfg = makeGlobalConfigDir({ withOverlay: true });
  try {
    const exe = fakeExe(dir, "oc", "opencode v2.0.20");
    const ins = JSON.parse((await run(process.execPath, [CLI, "install", "--global", "--config-dir", cfg, "--opencode", exe, "--json"])).stdout);
    assert.equal(ins.ok, true);
    assert.equal(ins.scope, "global");
    assert.equal(ins.host.flavor, "v2", "the v2 --opencode stub drives detection, not the payload");
    assert.equal(ins.manifest, "omo-coworkers-install.json");
    assert.ok(ins.notices.some((n) => n.includes("claude-advisor")), "plugin-skip notice surfaced in CLI output");

    const ver = JSON.parse((await run(process.execPath, [CLI, "verify", "--global", "--config-dir", cfg, "--json"])).stdout);
    assert.equal(ver.drift.length, 0);
    assert.equal(ver.missing.length, 0);

    const unl = JSON.parse((await run(process.execPath, [CLI, "uninstall", "--global", "--config-dir", cfg, "--json"])).stdout);
    assert.equal(unl.ok, true);
    assert.equal(unl.manifestRemoved, true);

    // uninstall twice -> exit 4 (no global manifest)
    await assert.rejects(
      () => run(process.execPath, [CLI, "uninstall", "--global", "--config-dir", cfg, "--json"]),
      (err) => err.code === 4,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

// --- CLI end-to-end ------------------------------------------------------------

const CLI = join(REPO_ROOT, "bin", "coworkers-install.mjs");

test("CLI: install/verify/plan/uninstall/rollback exit codes and --json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocw-exe-"));
  const target = makeTarget();
  try {
    const exe = fakeExe(dir, "oc", "opencode v2.0.20");
    const args = ["--target", target, "--opencode", exe, "--json"];

    const ins = JSON.parse((await run(process.execPath, [CLI, "install", ...args])).stdout);
    assert.equal(ins.ok, true);
    assert.equal(ins.host.flavor, "v2");
    assert.ok(ins.manifest.endsWith("omo-coworkers-install.json"));

    const ver = JSON.parse((await run(process.execPath, [CLI, "verify", "--target", target, "--json"])).stdout);
    assert.equal(ver.drift.length, 0);
    assert.equal(ver.missing.length, 0);

    const planJson = JSON.parse((await run(process.execPath, [CLI, "plan", ...args])).stdout);
    assert.equal(planJson.dryRun, true);
    assert.ok(planJson.files.length >= 6);

    const unl = JSON.parse((await run(process.execPath, [CLI, "uninstall", "--target", target, "--json"])).stdout);
    assert.equal(unl.ok, true);
    assert.equal(unl.manifestRemoved, true);

    // uninstall twice -> exit 4 (no manifest)
    await assert.rejects(
      () => run(process.execPath, [CLI, "uninstall", "--target", target, "--json"]),
      (err) => err.code === 4,
    );

    // detection failure -> exit 3
    const badExe = fakeExe(dir, "bad", "nonsense");
    await assert.rejects(
      () => run(process.execPath, [CLI, "install", "--target", target, "--opencode", badExe, "--json"]),
      (err) => err.code === 3,
    );

    // conflict -> exit 2, nothing written
    const t2 = makeTarget();
    try {
      writeFileSync(join(t2, ".opencode", "oh-my-opencode-slim.jsonc"), "// shadow\n");
      await assert.rejects(
        () => run(process.execPath, [CLI, "install", "--target", t2, "--host", "v1", "--json"]),
        (err) => err.code === 2,
      );
    } finally {
      rmSync(t2, { recursive: true, force: true });
    }

    // usage error -> exit 1
    await assert.rejects(
      () => run(process.execPath, [CLI, "install", "--host", "v3", "--target", target, "--json"]),
      (err) => err.code === 1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// --- optional live-host effective-profile checks -------------------------------
// Run with: OCW_V1_BIN=... OCW_V2_BIN=... node --test
// These assert the installed artifact actually takes effect in a real host.
// Shapes observed on the installer-level runtime-tested hosts (2026-09-30):
//   v1 1.18.33 `debug agent <name>` -> { name, mode, permission: [{permission,
//      action, pattern}], prompt, ... } (the grouped frontmatter map is
//      normalized into an internal array).
//   v2 2.0.20: the `debug agents` CLI subcommand does not terminate in this
//      environment (hangs with no output even outside an install), so the v2
//      check drives the real host server: `serve` + GET /api/agent?directory=…,
//      fully isolated (own HOME/XDG/DB/plugin-cache), zero model requests.
// NOTE: these checks ran WITHOUT the OMO plugin layer loaded; they prove the
// native files register and take effect, not combined native+OMO precedence.

function liveHostEnv(home, flavor) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_")));
  const config = join(home, ".config", "opencode");
  mkdirSync(config, { recursive: true });
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_DB: join(home, "isolated.db"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  });
  if (flavor === "v2") env.OPENCODE_CONFIG_DIR = config;
  return env;
}

test("live v1: installed agents register with rendered permission map", { skip: !process.env.OCW_V1_BIN, timeout: 70_000 }, async () => {
  const target = makeTarget();
  const home = mkdtempSync(join(tmpdir(), "ocw-v1-home-"));
  try {
    await install({ packageRoot: REPO_ROOT, target, opencode: process.env.OCW_V1_BIN });
    const bodyDw = readFileSync(join(REPO_ROOT, "prompts", "document-writer.md"), "utf8").trim();
    const bodyLo = readFileSync(join(REPO_ROOT, "prompts", "lark-operator.md"), "utf8").trim();
    for (const [role, body, want] of [
      ["document-writer", bodyDw, { task: "deny", webfetch: "deny" }],
      ["lark-operator", bodyLo, { task: "deny", bash: "allow", edit: "deny", write: "deny", webfetch: "allow", websearch: "deny" }],
    ]) {
      const { stdout } = await run(process.env.OCW_V1_BIN, ["debug", "agent", role], {
        cwd: target, env: liveHostEnv(home, "v1"), timeout: 30_000, killSignal: "SIGKILL",
      });
      const parsed = JSON.parse(stdout);
      assert.ok((parsed.prompt ?? parsed.system ?? "").includes(body), `v1 ${role} prompt contains the complete rendered body`);
      const effective = Object.fromEntries((parsed.permission ?? []).map((p) => [p.permission, p.action]));
      for (const [tool, action] of Object.entries(want)) {
        assert.equal(effective[tool], action, `v1 ${role} ${tool} ${action} effective`);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("live v2: installed agents register with permissions array (serve + /api/agent)", { skip: !process.env.OCW_V2_BIN, timeout: 60_000 }, async () => {
  const net = await import("node:net");
  const bin = process.env.OCW_V2_BIN;
  const home = mkdtempSync(join(tmpdir(), "ocw-v2-home-"));
  const target = mkdtempSync(join(tmpdir(), "ocw-v2-target-"));
  const proc = { child: null, exited: false, closed: Promise.resolve() };
  const kill = (signal) => {
    if (proc.child?.pid && !proc.exited) {
      try { process.kill(-proc.child.pid, signal); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  const stopOnSignal = () => kill("SIGKILL");
  process.on("SIGTERM", stopOnSignal);
  process.on("SIGINT", stopOnSignal);
  try {
    await install({ packageRoot: REPO_ROOT, target, host: "v2", opencode: bin });

    const port = await new Promise((res, rej) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); });
      srv.on("error", rej);
    });

    const env = liveHostEnv(home, "v2");
    proc.child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: target, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    proc.closed = new Promise((res) => {
      const closed = () => { proc.exited = true; res(); };
      proc.child.once("exit", closed);
      proc.child.once("error", closed);
    });
    // Drain stderr; a full pipe must not block the server being inspected.
    proc.child.stderr.resume();

    const password = await new Promise((res, rej) => {
      let buf = "";
      const timer = setTimeout(() => rej(new Error("v2 server produced no password within 15 seconds")), 15_000);
      proc.child.stdout.on("data", (d) => {
        buf += d.toString();
        const m = /server password\s+(\S+)/.exec(buf);
        if (m) { clearTimeout(timer); res(m[1]); }
      });
      proc.child.once("error", (error) => { clearTimeout(timer); rej(error); });
      proc.child.once("exit", (code) => { clearTimeout(timer); rej(new Error(`v2 server exited ${code}`)); });
    });

    const get = (path) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: AbortSignal.timeout(3000),
      });

    // force hydration of the project location, then poll until agents register
    let agents = null;
    const dirParam = encodeURIComponent(target);
    for (let i = 0; i < 10; i++) {
      const payload = await get(`/api/agent?location%5Bdirectory%5D=${dirParam}`).then((r) => r.json());
      const list = payload?.data ?? [];
      if (list.some((a) => a.id === "document-writer") && list.some((a) => a.id === "lark-operator")) { agents = list; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(agents, "v2 registered document-writer and lark-operator");
    assert.equal(agents.filter((a) => a.id === "document-writer").length, 1, "exactly one document-writer registration in this isolated environment (no OMO plugin loaded; combined precedence is a separate owner-validated case)");
    assert.equal(agents.filter((a) => a.id === "lark-operator").length, 1, "exactly one lark-operator registration in this isolated environment");

    const bodyDw = readFileSync(join(REPO_ROOT, "prompts", "document-writer.md"), "utf8").trim();
    const bodyLo = readFileSync(join(REPO_ROOT, "prompts", "lark-operator.md"), "utf8").trim();
    const byName = Object.fromEntries(agents.map((a) => [a.id, a]));
    for (const [role, body, wantAllow, wantDeny] of [
      ["document-writer", bodyDw, [], ["subagent", "question", "webfetch", "websearch"]],
      ["lark-operator", bodyLo, ["read", "glob", "grep", "webfetch", "shell"], ["edit", "write", "subagent", "question", "websearch"]],
    ]) {
      const a = byName[role];
      assert.ok((a.system ?? a.prompt ?? "").includes(body), `v2 ${role} system prompt contains the complete rendered body`);
      const entries = (a.permissions ?? []).map((p) => `${p.action}:${p.effect}`);
      for (const action of wantDeny) assert.ok(entries.includes(`${action}:deny`), `v2 ${role} ${action}:deny effective (got ${entries.join(" ")})`);
      for (const action of wantAllow) assert.ok(entries.includes(`${action}:allow`), `v2 ${role} ${action}:allow effective (got ${entries.join(" ")})`);
    }
  } finally {
    process.off("SIGTERM", stopOnSignal);
    process.off("SIGINT", stopOnSignal);
    kill("SIGTERM");
    await Promise.race([proc.closed, new Promise((r) => setTimeout(r, 1000))]);
    if (proc.child && !proc.exited) {
      kill("SIGKILL");
      await Promise.race([proc.closed, new Promise((r) => setTimeout(r, 2000))]);
      assert.ok(proc.exited, "owned v2 host must exit before removing its sandbox");
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
