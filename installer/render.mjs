// Pure renderer: host flavor + package source files -> artifact plan.
//
// Prompt authority: prompts/document-writer.md and prompts/lark-operator.md are
// the ONLY prompt sources. Their bodies are copied verbatim into native host
// agent files (v1: .opencode/agent/<name>.md, v2: .opencode/agents/<name>.md).
// No OMO prompt-dir copies are written and the OMO overlay carries no
// prompt/system text, so each role's effective prompt comes only from the
// native agent file. Observed on real hosts WITHOUT the OMO plugin loaded
// (v1 1.18.33 `debug agent <name>` shows the body as the agent prompt; v2
// 2.0.20 via the server API shows it as `system`); this does not by itself
// establish combined native+OMO precedence when the plugin layer is also
// loaded — that combined runtime validation is tracked separately by the owner.
//
// Permission vocabulary is rendered per host:
//   v1 native agent frontmatter: grouped `permission` map (v1 tool names:
//   bash/task/write/edit/...), validated on 1.18.33.
//   v2 native agent frontmatter: ordered `permissions` array of
//   {action, resource, effect}; action renames confirmed in the 2.0.20 host:
//   task->subagent, bash->shell; read/edit/write/glob/grep/question/webfetch/
//   websearch pass through. The OMO overlay itself keeps the OMO schema
//   vocabulary (OMO 3.0.1 translates internally per host flavor).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

export const ROLES = ["document-writer", "lark-operator"];
export const MANIFEST_NAME = "omo-coworkers-install.json";
export const OVERLAY_PROJECT = ".opencode/oh-my-opencode-slim.json";

// Global (user-level) install layout, resolved against the OpenCode config
// directory (~/.config/opencode). The host natively reads user-level agents
// from {agent,agents}/ and skills from {skill,skills}/; OMO 3.0.x resolves a
// custom agent's prompt body from <configDir>/oh-my-opencode-slim/<role>.md
// (file beats builtin fallback) and the agent DEFINITIONS from
// <configDir>/oh-my-opencode-slim.json `agents` keys. Prompt bodies are the
// verbatim repo prompts (no frontmatter — these are OMO prompt-body files, not
// native agent definitions), and skills use the plural `skills/` convention.
// The claude-advisor plugin is NOT part of the global payload: user-level
// plugins auto-load only from <configDir>/{plugin,plugins}/*.  {ts,js} one
// level deep, so a subdirectory payload would need an explicit `plugin` entry
// in the owner's personal opencode.json, which this installer never edits.
export const GLOBAL_PROMPT_DIR = "oh-my-opencode-slim";
export const OVERLAY_GLOBAL = "oh-my-opencode-slim.json";
export const GLOBAL_SKILL_DIR = "skills";

// Managed plugin payload — a single loose file, identical for both host
// flavors: OpenCode auto-loads project plugins from `.opencode/plugins/` at
// startup (official convention, https://opencode.ai/docs/plugins). Layout
// subdirectories are not documented for plugin loading, so claude-advisor
// ships as one loose file copied verbatim from plugins/claude-advisor/. The
// entry was split by host generation in 2533227 — index.js carries the v2
// plugin contract (default export {id, setup(ctx)}), index.v1.mjs the v1
// tool.execute.before hook — so the payload source is selected BY HOST
// FLAVOR while the managed path stays identical (guard.test.mjs is the
// plugin's own test suite and is not shipped). The plugin is useful against
// an oh-my-opencode-slim 3.0.x host (its acp_run guard protects a claude
// advisor dispatched via omo-slim); that omo-slim requirement stays
// DOCUMENTED-ONLY — the installer never detects or gates the omo-slim
// version.
export const PLUGIN_PAYLOAD = {
  kind: "plugin",
  path: ".opencode/plugins/claude-advisor.mjs",
  sourceByFlavor: {
    v1: "plugins/claude-advisor/index.v1.mjs",
    v2: "plugins/claude-advisor/index.js",
  },
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function readRoleBody(packageRoot, role) {
  const src = readFileSync(join(packageRoot, "prompts", `${role}.md`), "utf8");
  if (/^(---\r?\n)/.test(src)) {
    throw new Error(`prompts/${role}.md must not carry YAML frontmatter; the renderer owns frontmatter`);
  }
  return src.replace(/\n*$/, "\n");
}

// --- host-native permission vocabulary --------------------------------------

// Shared intent per role, expressed once in neutral tool-family terms.
const INTENT = {
  "document-writer": {
    deny: ["delegation", "question", "webfetch", "websearch", "mcp-research"],
  },
  "lark-operator": {
    allow: ["read", "glob", "grep", "webfetch", "shell"],
    deny: ["edit", "write", "delegation", "question", "websearch", "mcp-research", "patch-tools"],
  },
};

const V1_FAMILY = {
  delegation: ["task"],
  question: ["question"],
  webfetch: ["webfetch"],
  websearch: ["websearch"],
  "mcp-research": ["gh_grep_*", "context7_*"],
  "patch-tools": ["apply_patch", "ast_grep_replace"],
  read: ["read"],
  glob: ["glob"],
  grep: ["grep"],
  edit: ["edit"],
  write: ["write"],
  shell: ["bash"],
};

// v2 action names confirmed in the @opencode/cli 2.0.20 binary
// (permission asserts: action:"shell"|"read"|"edit"|"write"|"glob"|"grep"|
// "subagent"|"question"|"webfetch"|"websearch"|"external_directory"|"skill";
// MCP tools assert action `<sanitized-server>_<sanitized-tool>`).
const V2_FAMILY = {
  delegation: ["subagent"],
  question: ["question"],
  webfetch: ["webfetch"],
  websearch: ["websearch"],
  "mcp-research": ["gh_grep_*", "context7_*"],
  "patch-tools": ["apply_patch", "ast_grep_replace"],
  read: ["read"],
  glob: ["glob"],
  grep: ["grep"],
  edit: ["edit"],
  write: ["write"],
  shell: ["shell"],
};

function permEntries(role, host) {
  const family = host === "v1" ? V1_FAMILY : V2_FAMILY;
  const intent = INTENT[role];
  const entries = [];
  for (const name of intent.allow ?? []) {
    for (const action of family[name]) entries.push([action, "allow"]);
  }
  for (const name of intent.deny ?? []) {
    for (const action of family[name]) entries.push([action, "deny"]);
  }
  return entries;
}

function v1PermissionYaml(role, indent) {
  const pad = " ".repeat(indent);
  const lines = permEntries(role, "v1").map(([action, effect]) => `${pad}"${action}": ${effect}`);
  return ["permission:", ...lines].join("\n");
}

function v2PermissionsYaml(role, indent) {
  const pad = " ".repeat(indent);
  const lines = permEntries(role, "v2").map(
    ([action, effect]) =>
      `${pad}- action: "${action}"\n${pad}  resource: "*"\n${pad}  effect: ${effect}`,
  );
  return ["permissions:", ...lines].join("\n");
}

export function renderAgentMarkdown(role, host, body, description) {
  const head =
    host === "v1"
      ? `---\ndescription: ${JSON.stringify(description)}\nmode: subagent\n${v1PermissionYaml(role, 2)}\n---\n`
      : `---\ndescription: ${JSON.stringify(description)}\nmode: subagent\n${v2PermissionsYaml(role, 2)}\n---\n`;
  return `${head}\n${body}`;
}

// --- artifact plan -----------------------------------------------------------

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

function collectSkillFiles(packageRoot, skillDir) {
  const skillsRoot = join(packageRoot, "skills");
  const skillIds = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const files = [];
  for (const id of skillIds) {
    const abs = join(skillsRoot, id);
    for (const file of listFilesRecursive(abs)) {
      const rel = relative(packageRoot, file).split(sep).join("/");
      files.push({
        path: `${skillDir}/${id}/${relative(abs, file).split(sep).join("/")}`,
        action: "create",
        kind: "skill",
        skill: id,
        source: rel,
        sha256: sha256(statSync(file).isFile() ? readFileSync(file) : Buffer.alloc(0)),
      });
    }
  }
  return { files, skillIds };
}

/**
 * Build the full artifact plan for one host flavor.
 * Returns { host, files: [{path (relative to target), action, content?,
 *          source?, sha256}], overlay, manifest }
 * path uses POSIX separators; content is a Buffer or string.
 */
export function renderPlan({ packageRoot, host, overlay }) {
  if (host !== "v1" && host !== "v2") throw new Error(`unknown host flavor: ${host}`);
  const agentDir = host === "v1" ? ".opencode/agent" : ".opencode/agents";
  const skillDir = host === "v1" ? ".opencode/skill" : ".opencode/skills";

  const files = [];

  for (const role of ROLES) {
    const body = readRoleBody(packageRoot, role);
    const description =
      overlay.agents?.[role]?.description ??
      (role === "document-writer"
        ? "Create/edit formal product, technical and management documents; review expression, structure, consistency and audience fit."
        : "Handle independent Lark reads and platform operations, excluding formal document writing and local file maintenance.");
    const content = renderAgentMarkdown(role, host, body, description);
    files.push({
      path: `${agentDir}/${role}.md`,
      action: "create",
      kind: "role-agent",
      role,
      content,
      sha256: sha256(Buffer.from(content)),
      sourceAuthority: `prompts/${role}.md`,
    });
  }

  const { files: skillFiles, skillIds } = collectSkillFiles(packageRoot, skillDir);
  files.push(...skillFiles);

  // plugin payload: same managed path on either flavor; the SOURCE entry is
  // selected by host flavor (see PLUGIN_PAYLOAD.sourceByFlavor)
  files.push({
    path: PLUGIN_PAYLOAD.path,
    action: "create",
    kind: PLUGIN_PAYLOAD.kind,
    source: PLUGIN_PAYLOAD.sourceByFlavor[host],
    sha256: sha256(readFileSync(join(packageRoot, PLUGIN_PAYLOAD.sourceByFlavor[host]))),
  });

  return {
    host,
    files,
    overlay,
    skillIds,
    agentDir,
    skillDir,
    manifestName: MANIFEST_NAME,
    overlayProject: OVERLAY_PROJECT,
    scope: "project",
  };
}

/**
 * Build the artifact plan for a GLOBAL (user-level) install into the OpenCode
 * config directory. Paths are relative to the config directory. The payload is
 * host-flavor-independent: prompt bodies are the verbatim repo prompts placed
 * where OMO 3.0.x resolves them (<configDir>/oh-my-opencode-slim/<role>.md),
 * skills land under the plural `skills/` host convention, and no plugin or
 * native agent .md files are rendered (see the consts above).
 */
export function renderGlobalPlan({ packageRoot, overlay }) {
  const files = [];
  for (const role of ROLES) {
    const body = readRoleBody(packageRoot, role);
    files.push({
      path: `${GLOBAL_PROMPT_DIR}/${role}.md`,
      action: "create",
      kind: "role-prompt",
      role,
      content: body,
      sha256: sha256(Buffer.from(body)),
      sourceAuthority: `prompts/${role}.md`,
    });
  }
  const { files: skillFiles, skillIds } = collectSkillFiles(packageRoot, GLOBAL_SKILL_DIR);
  files.push(...skillFiles);
  return {
    files,
    overlay,
    skillIds,
    agentDir: null,
    skillDir: GLOBAL_SKILL_DIR,
    manifestName: MANIFEST_NAME,
    overlayProject: OVERLAY_GLOBAL,
    scope: "global",
  };
}

export { sha256 };
