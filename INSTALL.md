# Install (`omo-coworkers` 4.0.0 — OpenChamber 2.7.2 Git URL Extension)

Starting in `4.0.0`, `omo-coworkers` is a root-level OpenChamber 2.7.2 extension (`panel.id: "omo-coworkers"`). It contributes the three portable coworker skills (`skills/`) and an operator-opt-in V2 plugin wrapper (`openchamber/plugin`) for the Claude dispatch guard.

> **Breaking change from `3.x` (`coworkers-install` / `dw-install` removed)**:
> - The `bin/coworkers-install.mjs` CLI (`coworkers-install` / `dw-install`), `installer/`, `prompts/document-writer.md`, `prompts/lark-operator.md`, and root `oh-my-opencode-slim.json` overlay have been removed in `4.0.0`.
> - Role definitions (`document-writer`, `lark-operator`, and builtin-role appends) and OMO overlay configuration are **no longer shipped or configured by this repository or extension**. Local role files and OMO configuration (for example, managed via personal dotfiles such as [dotfiles/opencode](https://github.com/LittleKey/dotfiles/tree/master/opencode)) are the sole authority for roles.
> - Existing files previously installed on any machine or project by `3.x` remain untouched on disk; nothing is automatically deleted or migrated.
> - The `plugins/supervisor/` plugin and `bin/supervisor-memory.mjs` CLI remain in this repository as a separate tool surface and are **not** registered by the OpenChamber extension.

---

## 1. Installing the OpenChamber 2.7.2 Extension via GitHub URL

The repository root (`package.json` version `4.0.0`) is a self-contained, prebuilt OpenChamber extension (`engines.openchamber: ">=2.7.2"`, `apiVersion: 1`) with zero external runtime dependencies and no `install` or `build` hooks.

1. **Remote availability prerequisite**:
   The GitHub URL installation path works only after the `4.0.0` release commit is pushed to the remote repository (`https://github.com/LittleKey/omo-coworkers.git`). Before pushing, validate locally from the working tree (see §5).
2. **GitHub URL format (root only, optional branch/tag `#ref`)**:
   In OpenChamber 2.7.2, install from the repository root URL:
   ```text
   https://github.com/LittleKey/omo-coworkers.git
   ```
   Or pin a branch or tag ref:
   ```text
   https://github.com/LittleKey/omo-coworkers.git#<branch-or-tag>
   ```
   *Note*: OpenChamber Git URL sources do **not** support subdirectory syntax; always point to the repository root.
3. **What the extension registers**:
   - `contributes.panel`: `{ "id": "omo-coworkers", "name": "OMO Coworkers", "icon": "ri-team-line" }` (metadata panel ID, no custom UI entry bundle).
   - `contributes.skills`: `"skills"` — exposes `maintaining-product-engineering-docs`, `domain-modeling`, and `humanizer`.
   - `contributes.opencodePlugin`: `"openchamber/plugin"` — registers `openchamber/plugin/index.mjs` (plugin ID `"omo-coworkers"`).

---

## 2. Optional Claude Dispatch Guard (`OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`)

By default, the extension's OpenCode plugin (`openchamber/plugin/index.mjs`) is **disabled (default off)**:

- When `OMO_COWORKERS_ENABLE_CLAUDE_GUARD` is unset, empty, or any value other than `"1"` (including `"0"` or `"true"`), `setup(ctx)` returns immediately without registering any tool hooks.
- To enable the Claude dispatch guard in the OpenChamber/OpenCode V2 host process, set the exact environment variable in the operator-controlled host process environment before starting the service:
  ```bash
  export OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1
  ```
- **Operator authority boundary**: only `process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD === "1"` enables the wrapper. Session state and plugin `ctx.options` cannot enable or override it.
- When enabled, the wrapper delegates to `plugins/claude-advisor/index.js` (`ctx.tool.hook("execute.before", ...)`), enforcing printable-ASCII and byte-cap checks on `claude` dispatches (`task`/`subagent` and `acp_run` with `{ agent, prompt }` only).
- For standalone local/dotfiles deployments outside the OpenChamber extension, `plugins/claude-advisor/index.v1.mjs` (v1) and `plugins/claude-advisor/index.js` (v2) remain unchanged and unconditional when loaded directly.

---

## 3. Upstream Update Semantics in OpenChamber 2.7.2

- **Semver-based detection**: OpenChamber 2.7.2 checks for extension updates by comparing the remote root `package.json` `version` (semver) against the installed version. Pushing new commits without bumping the root semver `version` does not register as an available update.
- **One-hour cache & manual apply**: the host caches update checks for one hour and requires a separate explicit user action to apply an update. There is no automatic background self-update.

---

## 4. Collision, Coexistence, and Migration Boundary

- **No automatic deletion of deployed copies**: removing the installer from this repository does not modify or delete any files already installed in `~/.config/opencode/`, `~/.agents/skills/`, or project `.opencode/` directories.
- **Potential collisions with existing global/project installs**:
  - Hosts that already have global or project copies of `maintaining-product-engineering-docs`, `domain-modeling`, or `humanizer` (for example, from an earlier `3.x` `--global` install or personal dotfiles) will have duplicate skill definitions if the OpenChamber extension is also installed.
  - Hosts that already load `claude-advisor` directly (via `.opencode/plugins/claude-advisor.mjs` or personal dotfiles configuration) would register the `execute.before` hook twice if `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` is also enabled on the extension.
- **Explicit ownership decision required**: do not rely on silent loader precedence across duplicate skill or plugin sources. Before activating the `4.0.0` OpenChamber extension on an existing machine, the operator must make a separate migration/ownership decision (which source owns the skills and whether the Claude guard is loaded via dotfiles or via `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`).
- **Role configuration authority**: `document-writer`, `lark-operator`, and builtin-role appends are managed solely through local configuration files (for example, in the operator's personal dotfiles repository) and never through this OpenChamber extension.

---

## 5. Verification

From a repository checkout (Node `>=20`):

```bash
npm test
# Runs: node --test test/*.test.mjs plugins/claude-advisor/guard.test.mjs
```

- When `OPENCHAMBER_WEB_ROOT` points to an installed OpenChamber `2.7.2` package root (e.g., `/path/to/installed/@openchamber/web`), `test/openchamber-package.test.mjs` copies the published `package.json` + `files` payload into an isolated temp directory without `node_modules`, confirms the retired `3.x` paths (`installer`, `prompts`, `oh-my-opencode-slim.json`, `bin/coworkers-install.mjs`) are absent, validates the package through the real host's `inspectGuestPackage(..., { openchamberVersion: "2.7.2" })` and `resolveOpenCodePluginFolder`, and verifies cold-load behavior across `OMO_COWORKERS_ENABLE_CLAUDE_GUARD` values (`undefined`, `"0"`, `"true"`, `"1"`).
- Separate supervisor tests remain under `plugins/supervisor/test/` (see [`plugins/supervisor/README.md`](plugins/supervisor/README.md)).

---

## 6. Historical Archive: Retiring or Cleaning Up `3.x` / `2.x` Installations

> **Archived historical reference only — do not run `coworkers-install` or `dw-install` from a `4.0.0` checkout** (those commands no longer exist in `4.0.0`).

If a target machine or project still has files installed by `omo-coworkers` `3.x` (or `2.x`) and the owner explicitly decides to remove or migrate them:

- **Recorded manifests from `3.x` / `2.x` installs**:
  - Project installs recorded `.opencode/omo-coworkers-install.json` (or `.opencode/document-writer-install.json` on `≤2.x`) and optional backups under `.opencode/omo-coworkers-backup/<stamp>/`.
  - Global installs (`3.3.0`) recorded `<configDir>/omo-coworkers-install.json` and backups under `<configDir>/omo-coworkers-backup/<stamp>/`, alongside `oh-my-opencode-slim/<role>.md`, `skills/{maintaining-product-engineering-docs,domain-modeling,humanizer}/`, and additive entries in `oh-my-opencode-slim.json`.
- **How to reverse an older install if desired**:
  - Inspect the recorded manifest (`omo-coworkers-install.json`) and remove or hand over only the paths whose hashes and ownership you have verified (or run the historical uninstaller from a pinned `v3.3.0` git checkout/tag before migrating ownership to dotfiles or the `4.0.0` extension).
  - Never delete modified or personal configuration files blindly; on machines managed by personal dotfiles, coordinate ownership through the dotfiles runtime inventory rather than ad-hoc deletion.
