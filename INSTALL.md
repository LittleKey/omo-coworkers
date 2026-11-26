# Install (`omo-coworkers` 4.0.0 — OpenChamber 2.7.2+ Git URL Extension)

Starting in `4.0.0`, `omo-coworkers` is a root-level OpenChamber 2.7.2+ extension (`panel.id: "omo-coworkers"`). It contributes the three portable coworker skills (`skills/`), ships the four frozen upstream `document-writer` expression and routing payloads (`openchamber/plugin/roles/`), and provides an OpenCode V2 plugin entry (`openchamber/plugin/index.mjs`) whose two runtime hooks are **both disabled by default** and independently gated by exact operator environment variables (`OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` and the retained legacy opt-in `OMO_COWORKERS_ENABLE_WRITER_ROLE=1`).

> **Breaking change from `3.x` (`coworkers-install` / `dw-install` removed; static role delivery owned by local dotfiles)**:
> - The `bin/coworkers-install.mjs` CLI (`coworkers-install` / `dw-install`), `installer/`, `prompts/document-writer.md`, `prompts/lark-operator.md`, and root `oh-my-opencode-slim.json` overlay have been removed in `4.0.0` and are not restored.
> - **Upstream semantic payloads vs. static dotfiles ownership**: `openchamber/plugin/roles/{document-writer.md,routing.json,audience.md,oracle-line.txt}` is the upstream semantic source for `document-writer` expression and targeted `orchestrator`/`oracle` routing. Personal OpenCode dotfiles (such as [dotfiles/opencode](https://github.com/LittleKey/dotfiles/tree/master/opencode)) owns the complete static OMO files (`oh-my-opencode-slim/document-writer.md`, `oh-my-opencode-slim.json` `agents["document-writer"].description` and `.orchestratorPrompt`, `oh-my-opencode-slim/orchestrator_append.md` `# Audience and dispatch`, and `oh-my-opencode-slim/oracle_append.md`), personal `model`/`skills`/`permissions`, `lark-operator`, and explicit offline snapshot updates (`update-writer-role.mjs`) plus `oprofile` staging/installation.
> - **Do not enable `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` alongside static dotfiles delivery**: the plugin's runtime `ctx.agent.transform` writer hook is off by default and retained only as an explicit legacy opt-in.
> - Existing files previously installed on any machine or project by `3.x` remain untouched on disk; nothing is automatically deleted or migrated.
> - The `plugins/supervisor/` plugin and `bin/supervisor-memory.mjs` CLI remain in this repository as a separate tool surface and are **not** registered by the OpenChamber extension.

---

## 1. Prerequisites & Installing the Extension via GitHub URL

The repository root (`package.json` version `4.0.0`) is a self-contained, prebuilt OpenChamber extension (`engines.openchamber: ">=2.7.2"`, `apiVersion: 1`) with zero external runtime dependencies and no `install` or `build` hooks.

1. **Distinct delivery stages**:
   Source checkout edits, local Git commits, offline `dotfiles/opencode` snapshot updates (`update-writer-role.mjs`), `oprofile` staging/activation, remote published GitHub commits, and OpenChamber extension updates are separate actions. Committing to `omo-coworkers` or `dotfiles` never automatically installs files into `~/.config/opencode` or reloads a running host. Because `package.json` remains `4.0.0` until a separately authorized release bump, local checkout changes are not active at the remote GitHub URL until pushed, and an already-installed `4.0.0` extension will not auto-detect same-version commits via OpenChamber's semver update check (see §4).
2. **GitHub URL format (root only, optional branch/tag `#ref`)**:
   In OpenChamber (`>=2.7.2`), install from the repository root URL:
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
   - `contributes.opencodePlugin`: `"openchamber/plugin"` — registers `openchamber/plugin/index.mjs` (plugin ID `"omo-coworkers"`, a no-op during `setup(ctx)` unless `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` or `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` is set in the host process environment).

---

## 2. Static Dotfiles Consumption vs. Legacy Opt-In Writer Transform (`OMO_COWORKERS_ENABLE_WRITER_ROLE=1`)

### Primary workflow: static offline consumption in `dotfiles/opencode`

In a personal OpenCode dotfiles setup (`dotfiles/opencode`), `omo-coworkers` is never used to dynamically mutate prompts at runtime or copy files during host startup. Instead:

- An operator explicitly pulls reviewed, committed payloads from a local `omo-coworkers` Git repository into `dotfiles/opencode` using the offline updater from the `dotfiles` repository root:
  ```bash
  node opencode/runtime/bin/update-writer-role.mjs /path/to/local/omo-coworkers <FULL_40_HEX_COMMIT>
  ```
- The updater reads only immutable regular-file Git blobs (`openchamber/plugin/roles/{document-writer.md,routing.json,audience.md,oracle-line.txt}`) at the lowercase 40-hex commit (ignoring dirty working-tree edits, requiring `remote.origin.url` to match `runtime/resources/writer-role/SOURCE.json`, and performing no network fetch), verifies the four reviewed SHA-256 pins in `opencode/runtime/lib/writer-role-update.mjs`, updates the snapshot and composed static OMO files (`oh-my-opencode-slim/document-writer.md`, `oh-my-opencode-slim.json` `agents["document-writer"].description` and `.orchestratorPrompt`, `oh-my-opencode-slim/orchestrator_append.md` `# Audience and dispatch`, `oh-my-opencode-slim/oracle_append.md`, and `runtime/profile.json`), and records the bound commit in `runtime/resources/writer-role/SOURCE.json`.
- Static OMO composition places the `document-writer` delegation paragraph **only** in `oh-my-opencode-slim.json` (`agents["document-writer"].orchestratorPrompt`), never duplicating it inside `orchestrator_append.md`.
- Updating `dotfiles/opencode` files and binding `SOURCE.json` (`deployable: true`) records provenance readiness only; staging and installing into `~/.config/opencode` still require the separate `oprofile` stage/verify/activate workflow documented in `dotfiles/opencode/runtime/README.md` and `dotfiles/opencode/BOOTSTRAP.md`.
- **Keep `OMO_COWORKERS_ENABLE_WRITER_ROLE` unset (off)** on machines using static dotfiles delivery.

### Retained legacy opt-in: runtime `ctx.agent.transform` (`OMO_COWORKERS_ENABLE_WRITER_ROLE=1`)

For non-dotfiles environments that explicitly choose the legacy runtime transform path, `openchamber/plugin/index.mjs` gates `setupWriterRole(ctx)` (`openchamber/plugin/writer-role.mjs`) on an exact operator environment variable:

```bash
export OMO_COWORKERS_ENABLE_WRITER_ROLE=1
```

- **Default off & operator authority**: when `OMO_COWORKERS_ENABLE_WRITER_ROLE` is unset or any value other than `"1"` (including `"0"`, `"false"`, `"true"`, or `ctx.options.OMO_COWORKERS_ENABLE_WRITER_ROLE`), `setupWriterRole(ctx)` is not called and zero agent transforms or `[omo-coworkers/writer-role]` warnings are emitted.
- **Behavior when opted in**:
  - Reads the four frozen files under `openchamber/plugin/roles/` via `import.meta.url` during `setup(ctx)`, verifies their pinned SHA-256 hashes, and registers a synchronous `ctx.agent.transform` callback (never a per-turn message hook or file copier).
  - Requires an existing, non-disabled `document-writer` role with `mode: "subagent"` or `"all"`. It never creates, upserts, resurrects, or deletes any role, and updates only `document-writer.system` and `document-writer.description`, two slots in `orchestrator.system` (`# Audience and dispatch` and the standalone `document-writer` routing paragraph), and the single editorial routing line in `oracle.system`, preserving all other fields (`model`, `permissions`, `skills`, `mode`, `hidden`, etc.).
  - Precomputes all target `system` strings and aborts with zero role mutations on missing writer prerequisites or predictable routing conflicts (duplicate/custom slots, unclosed fences, or unrecognized active `document-writer` mentions).
  - Emits bounded `[omo-coworkers/writer-role]` warning codes **only when opted in**: `NATIVE_AGENT_TRANSFORM_UNAVAILABLE`, `ROLE_PAYLOAD_INVALID`, `WRITER_PREREQUISITE_MISSING`, `WRITER_MODE_INCOMPATIBLE`, `ROUTING_TARGET_ABSENT`, `ROUTING_CONFLICT`, or `ROLE_REGISTRATION_FAILED` (never logging prompt or config contents).

---

## 3. Optional Claude Dispatch Guard (`OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`)

The Claude dispatch guard in `openchamber/plugin/index.mjs` is also **disabled by default (opt-in only)** and completely independent of `OMO_COWORKERS_ENABLE_WRITER_ROLE`:

- When `OMO_COWORKERS_ENABLE_CLAUDE_GUARD` is unset, empty, or any value other than `"1"` (including `"0"` or `"true"`), `setup(ctx)` does not register the Claude tool hook.
- To enable the Claude dispatch guard in the OpenChamber/OpenCode V2 host process, set the exact environment variable in the operator-controlled host process environment before starting the service:
  ```bash
  export OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1
  ```
- **Operator authority & independence**: only `process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD === "1"` enables the guard. Session state and plugin `ctx.options` cannot enable or override it, and its activation does not depend on `OMO_COWORKERS_ENABLE_WRITER_ROLE` or writer role prerequisites.
- When enabled, the wrapper delegates to `plugins/claude-advisor/index.js` (`ctx.tool.hook("execute.before", ...)`), enforcing printable-ASCII and byte-cap checks on `claude` dispatches (`task`/`subagent` and `acp_run` with `{ agent, prompt }` only).
- For standalone local/dotfiles deployments outside the OpenChamber extension, `plugins/claude-advisor/index.v1.mjs` (v1) and `plugins/claude-advisor/index.js` (v2) remain unchanged and unconditional when loaded directly.

---

## 4. Upstream Update & Uninstall Semantics

- **Semver-based update detection**: OpenChamber checks for extension updates by comparing the remote root `package.json` `version` (semver) against the installed version. Pushing new commits without bumping the root semver `version` does not register as an available update. The host caches update checks for one hour and requires a separate explicit user action to apply an update (no automatic background self-update).
- **Host managed config vs. user/dotfiles role files**: this extension never writes or modifies user or dotfiles role files on disk. The OpenChamber host itself maintains its own managed configuration or environment delivery for active extensions.
- **Uninstalling or disabling the extension**: removing or disabling `omo-coworkers` removes the extension's contributed skills and any opted-in plugin hooks once the host refreshes or restarts its OpenCode plugin lifecycle. Uninstalling the extension **never deletes or modifies static role, prompt, or config files installed by `dotfiles/opencode`**, never deletes an existing `document-writer` role, and does not guarantee immediate hot-unload without a host lifecycle refresh/restart.

---

## 5. Collision, Coexistence, and Migration Boundary

- **No automatic deletion of deployed copies**: removing the `3.x` installer from this repository does not modify or delete any files already installed in `~/.config/opencode/`, `~/.agents/skills/`, or project `.opencode/` directories.
- **Potential collisions with existing global/project/dotfiles installs**:
  - Hosts that already have global or project copies of `maintaining-product-engineering-docs`, `domain-modeling`, or `humanizer` (for example, from an earlier `3.x` `--global` install or personal dotfiles) will have duplicate skill definitions if the OpenChamber extension is also installed.
  - Hosts that already load `claude-advisor` directly (via `.opencode/plugins/claude-advisor.mjs` or personal dotfiles configuration) would register the `execute.before` hook twice if `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` is also enabled on the extension.
  - Hosts using static `dotfiles/opencode` delivery already provide `document-writer.md`, `oh-my-opencode-slim.json` (`agents["document-writer"].description` and `.orchestratorPrompt`), `orchestrator_append.md`, and `oracle_append.md`; leave `OMO_COWORKERS_ENABLE_WRITER_ROLE` unset (off) so the legacy runtime transform does not run alongside static OMO delivery.
- **Explicit ownership decision required**: do not rely on silent loader or transform precedence across duplicate skill or plugin sources. Coordinate which source owns the three skills and whether the Claude guard is loaded via dotfiles or `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`.

---

## 6. Verification & Post-Deployment Runtime Boundaries

### Repository unit and package tests (offline, no live host installation)

From a repository checkout (Node `>=20`), run the focused writer-role and package verification suite:

```bash
node --test test/writer-role.test.mjs test/openchamber-package.test.mjs
```

Or run with an installed OpenChamber package root (`>=2.7.2`) to include the host guest-package parser subtest:

```bash
OPENCHAMBER_WEB_ROOT=/path/to/installed/@openchamber/web node --test test/writer-role.test.mjs test/openchamber-package.test.mjs
```

- `test/openchamber-package.test.mjs` copies the published `package.json` + `files` allowlist into an isolated disk-backed temp directory without `node_modules` and runs from a different working directory, confirms the retired `3.x` paths (`installer`, `prompts`, `oh-my-opencode-slim.json`, `bin/coworkers-install.mjs`) are absent, runs `inspectGuestPackage` and `resolveOpenCodePluginFolder` when `OPENCHAMBER_WEB_ROOT` is set, verifies the 20-combination `(OMO_COWORKERS_ENABLE_WRITER_ROLE × OMO_COWORKERS_ENABLE_CLAUDE_GUARD)` cold-load gating matrix (confirming both features default off and ignore `ctx.options`), and verifies damaged-payload diagnosis (`ROLE_PAYLOAD_INVALID`) without blocking an opted-in Claude guard when both env vars are `"1"`.
- `test/writer-role.test.mjs` directly exercises `setupWriterRole(ctx)` and the opted-in legacy `ctx.agent.transform` path (frozen payload SHA-256 hashes, field preservation, byte-identical `system` strings across replay and fresh setups, legacy-to-current migration, conflict refusal, inert fenced examples, non-disclosing warnings, and Claude guard independence).
- The broader repository script `npm test` (`node --test test/*.test.mjs plugins/claude-advisor/guard.test.mjs`) remains unchanged, and separate supervisor tests remain under `plugins/supervisor/test/` (see [`plugins/supervisor/README.md`](plugins/supervisor/README.md)).

### Runtime boundaries not proven by repository tests

Repository tests prove deterministic offline assembly and env-gate isolation; they do **not** measure or guarantee upstream LLM provider prompt-cache hit rates, do **not** deploy changes to a live host, and do **not** verify live multi-plugin registration order or uninstall timing. After any separately authorized live deployment (whether activating a staged `dotfiles/opencode` candidate or enabling an extension feature in a live host), verify on the actual running server—not merely by process restart or static metadata—that:

1. **Final served agent definitions**: the running server's effective `document-writer` `system` body, `description`, `model`, `permissions`, `skills`, and `mode`, plus the effective `orchestrator` and `oracle` system prompts/routing, match the intended source without duplicate routing paragraphs or unexpected overrides.
2. **New-session behavior**: a newly started session dispatches `document-writer` with `MODE` and `PROFILE` (`COMMUNICATION` vs. `FORMAL`) as expected.

---

## 7. Historical Archive: Retiring or Cleaning Up `3.x` / `2.x` Installations

> **Archived historical reference only — do not run `coworkers-install` or `dw-install` from a `4.0.0` checkout** (those commands no longer exist in `4.0.0`).

If a target machine or project still has files installed by `omo-coworkers` `3.x` (or `2.x`) and the owner explicitly decides to remove or migrate them:

- **Recorded manifests from `3.x` / `2.x` installs**:
  - Project installs recorded `.opencode/omo-coworkers-install.json` (or `.opencode/document-writer-install.json` on `≤2.x`) and optional backups under `.opencode/omo-coworkers-backup/<stamp>/`.
  - Global installs (`3.3.0`) recorded `<configDir>/omo-coworkers-install.json` and backups under `<configDir>/omo-coworkers-backup/<stamp>/`, alongside `oh-my-opencode-slim/<role>.md`, `skills/{maintaining-product-engineering-docs,domain-modeling,humanizer}/`, and additive entries in `oh-my-opencode-slim.json`.
- **How to reverse an older install if desired**:
  - Inspect the recorded manifest (`omo-coworkers-install.json`) and remove or hand over only the paths whose hashes and ownership you have verified (or run the historical uninstaller from a pinned `v3.3.0` git checkout/tag before migrating ownership to dotfiles or the `4.0.0` extension).
  - Never delete modified or personal configuration files blindly; on machines managed by personal dotfiles, coordinate ownership through the dotfiles runtime inventory rather than ad-hoc deletion.
