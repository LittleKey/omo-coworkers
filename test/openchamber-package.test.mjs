import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const repo = fileURLToPath(new URL("../", import.meta.url))
const host = process.env.OPENCHAMBER_WEB_ROOT

test("root extension cold-loads offline without node_modules; optional installed host parser check",
  async t => {
    const sandbox = join(repo, ".opencode/work/validation")
    await fs.mkdir(sandbox, { recursive: true })
    const root = await fs.mkdtemp(join(sandbox, "package-"))
    try {
      const target = join(root, "extension")
      await fs.mkdir(target)
      const pkg = JSON.parse(await fs.readFile(join(repo, "package.json"), "utf8"))
      // Simulate the published payload, excluding dev fixtures and dependencies.
      await fs.writeFile(join(target, "package.json"), JSON.stringify(pkg))
      for (const name of pkg.files) await fs.cp(join(repo, name), join(target, name), { recursive: true })
      await assert.rejects(fs.stat(join(target, "node_modules")), { code: "ENOENT" })
      for (const retired of ["installer", "prompts", "oh-my-opencode-slim.json", "bin/coworkers-install.mjs"]) {
        await assert.rejects(fs.stat(join(target, retired)), { code: "ENOENT" })
      }
      assert.equal(Object.hasOwn(pkg, "bin"), false)
      const folder = join(target, pkg.openchamber.contributes.opencodePlugin)
      await t.test("installed host parses the extension", { skip: !host && "OPENCHAMBER_WEB_ROOT not set" }, async () => {
        const server = await fs.stat(join(host, "build/server")).then(() => join(host, "build/server"), () => join(host, "server"))
        const { inspectGuestPackage } = await import(pathToFileURL(join(server, "lib/guests/catalog.js")))
        const inspected = await inspectGuestPackage(target, { openchamberVersion: "2.8.0" })
        assert.equal(inspected.ok, true, JSON.stringify(inspected))
        assert.equal(inspected.guest.entryMobile, true)
        const { resolveOpenCodePluginFolder } = await import(pathToFileURL(join(server, "lib/guests/opencode-plugin.js")))
        assert.equal(await resolveOpenCodePluginFolder(fs, target, pkg.openchamber.contributes.opencodePlugin), folder)
      })
      assert.equal(folder, join(target, "openchamber/plugin"))
      const nested = JSON.parse(await fs.readFile(join(folder, "package.json"), "utf8"))
      assert.equal(nested.type, "module")
      assert.equal(pkg.version, "7.1.1")
      assert.equal(nested.version, pkg.version)
      assert.equal(pkg.openchamber.engines.openchamber, ">=2.8.0")
      assert.equal(pkg.openchamber.contributes.panel.entry, "openchamber/panel/index.html")
      assert.equal(pkg.openchamber.contributes.panel.mobile, true)
      assert.deepEqual(pkg.openchamber.contributes.service, {entry:"openchamber/service/main.mjs", runtime:"host"})
      assert.deepEqual(Object.keys(pkg.openchamber.contributes).sort(), ["opencodePlugin", "panel", "service", "skills"])
      await fs.access(join(target, pkg.openchamber.contributes.panel.entry))
      await fs.access(join(target, pkg.openchamber.contributes.service.entry))
      // Browser bridge is fully local; its entire static import closure relocates.
      await import(pathToFileURL(join(target, "openchamber/panel/vendor/host.js")))
      const switches = [undefined, "0", "false", "true", "1"].flatMap(writer =>
        [undefined, "0", "true", "1"].map(guard => [writer, guard]))
      const fixtureHome = join(root, "home")
      await fs.mkdir(fixtureHome, { mode: 0o700 })
      await fs.mkdir(join(root, "tmp"))
      for (const [writerEnabled, enabled] of switches) {
        const env = { ...process.env, HOME: fixtureHome, XDG_CONFIG_HOME: join(fixtureHome, ".config"), TMPDIR: join(root, "tmp") }
        delete env.OMO_COWORKERS_ENABLE_WRITER_ROLE
        if (writerEnabled !== undefined) env.OMO_COWORKERS_ENABLE_WRITER_ROLE = writerEnabled
        delete env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD
        if (enabled !== undefined) env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD = enabled
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
          import assert from "node:assert/strict";
          import plugin from ${JSON.stringify(pathToFileURL(join(folder, nested.exports)).href)};
          import { readFile } from "node:fs/promises";
          let calls = 0, handler, transforms = 0;
          const agents = {
            "document-writer": {mode:"subagent", model:"fixture", permissions:["deny"], skills:["fixture"]},
            orchestrator: {system:"Main rules."}, oracle: {system:"Read only."}
          };
          const originalAgents = structuredClone(agents);
          const preserved = structuredClone(agents["document-writer"]);
          const config = Object.freeze({ agents: Object.freeze({personal: true}) });
          const ctx = Object.freeze({ config, options: Object.freeze({enabled:true, OMO_COWORKERS_ENABLE_WRITER_ROLE:"1"}),
            agent: Object.freeze({transform: cb => {
              transforms++;
              cb({get: id => agents[id], update: (id, fn) => {assert.ok(agents[id]); fn(agents[id]);}});
            }}),
            tool: Object.freeze({hook: async (name, cb) => {
              assert.equal(name, "execute.before"); calls++; handler = cb;
            }}) });
          await plugin.setup(ctx);
          assert.equal(calls, ${enabled === "1" ? 1 : 0});
          assert.equal(transforms, ${writerEnabled === "1" ? 1 : 0});
          if (${writerEnabled === "1"}) {
          assert.equal(agents["document-writer"].system, await readFile(${JSON.stringify(join(folder, "roles/document-writer.md"))}, "utf8"));
          const routing = JSON.parse(await readFile(${JSON.stringify(join(folder, "roles/routing.json"))}, "utf8"));
          assert.equal(agents["document-writer"].description, routing.description);
          assert.ok(agents.orchestrator.system.includes(routing.orchestratorPrompt));
          assert.ok(agents.orchestrator.system.includes((await readFile(${JSON.stringify(join(folder, "roles/audience.md"))}, "utf8")).trimEnd()));
          assert.ok(agents.oracle.system.includes((await readFile(${JSON.stringify(join(folder, "roles/oracle-line.txt"))}, "utf8")).trimEnd()));
          const {system, description, ...untouched} = agents["document-writer"];
          assert.deepEqual(untouched, preserved);
          } else {
            assert.deepEqual(agents, originalAgents);
          }
          assert.deepEqual(config, {agents:{personal:true}});
          if (handler) {
            await handler({tool:"acp_run",input:{agent:"claude",prompt:"Read evidence."}});
            await assert.rejects(() => handler({tool:"acp_run",input:{agent:"claude",prompt:"Read.",cwd:"/elsewhere"}}));
          }
        `], { env, cwd: root, encoding: "utf8" })
        assert.equal(result.status, 0, `writer=${writerEnabled}, guard=${enabled}: ${result.stderr || result.error}`)
      }
      // A damaged installed payload must not partially apply, or disable opt-in guard.
      await fs.writeFile(join(folder, "roles/routing.json"), "{}\n")
      const damaged = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import plugin from ${JSON.stringify(pathToFileURL(join(folder, nested.exports)).href)};
        let hooks = 0, transforms = 0;
        const warnings = [];
        console.warn = message => warnings.push(message);
        await plugin.setup({
          agent: {transform() {transforms++;}},
          tool: {hook: async () => {hooks++;}}
        });
        assert.equal(transforms, 0);
        assert.equal(hooks, 1);
        assert.ok(warnings.some(x => x.includes("ROLE_PAYLOAD_INVALID")));
      `], { env: { ...process.env, OMO_COWORKERS_ENABLE_WRITER_ROLE: "1", OMO_COWORKERS_ENABLE_CLAUDE_GUARD: "1" }, cwd: root, encoding: "utf8" })
      assert.equal(damaged.status, 0, damaged.stderr || String(damaged.error))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
