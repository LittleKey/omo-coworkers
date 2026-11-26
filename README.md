# omo-coworkers

**OpenChamber 2.7.2+ extension (`v4.0.0`) shipping the three portable coworker skills, the upstream frozen `document-writer` expression and routing payloads (with a default-off legacy `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` native transform), and an independent operator-opt-in Claude dispatch guard (`OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`); static OMO role files, personal models/permissions/skills, and deployment remain managed in local configuration (such as `dotfiles/opencode`).**

「面向 OpenChamber 2.7.2+ 的扩展包：提供三项通用协作技能、`document-writer` 上游冻结表达与路由载荷（含默认关闭的旧版 `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` 原生转换可选开关）以及默认关闭的 Claude 派发守卫（`OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`）；静态 OMO 角色文件、模型、权限与实际部署仍由本地 `dotfiles/opencode` 独立管理。」

## What `v4.0.0` ships (and ownership split with local dotfiles)

Starting in `4.0.0`, `omo-coworkers` is a root-level OpenChamber 2.7.2+ extension (`panel.id: "omo-coworkers"`) rather than a file-writing role/overlay installer:

- **Bundled skills (`contributes.skills: "skills"`)** — ships the three portable skill directories verbatim:
  - `skills/maintaining-product-engineering-docs`
  - `skills/domain-modeling`
  - `skills/humanizer`
  No `lark-*` skills and no project-private skills are vendored.
- **Upstream `document-writer` semantic payloads (`openchamber/plugin/roles/`) & static dotfiles ownership**:
  - **Normative upstream payload authority**: the four frozen reader-aware files under `openchamber/plugin/roles/` (`document-writer.md`, `routing.json`, `audience.md`, `oracle-line.txt`) define the upstream expression and targeted `orchestrator`/`oracle` routing semantics for `document-writer`.
  - **Static OMO composition and deployment live in `dotfiles/opencode`**: personal OpenCode dotfiles (`dotfiles/opencode`) owns the complete static OMO prompt and config files (`oh-my-opencode-slim/document-writer.md`, `oh-my-opencode-slim.json` `agents["document-writer"].description` and `.orchestratorPrompt`, `oh-my-opencode-slim/orchestrator_append.md` `# Audience and dispatch`, and `oh-my-opencode-slim/oracle_append.md`), personal `model`/`skills`/`permissions`, and the explicit offline git-object updater (`node opencode/runtime/bin/update-writer-role.mjs /path/to/local/omo-coworkers <FULL_40_HEX_COMMIT>`) plus `oprofile` stage/verify/activate workflow. In static OMO delivery, the `document-writer` delegation paragraph lives **only** in `oh-my-opencode-slim.json` (`agents["document-writer"].orchestratorPrompt`) and is never duplicated in `orchestrator_append.md`.
  - **Legacy runtime writer transform is OFF by default (`OMO_COWORKERS_ENABLE_WRITER_ROLE=1`)**: `openchamber/plugin/index.mjs` invokes `setupWriterRole(ctx)` (`openchamber/plugin/writer-role.mjs`) **only** when the operator process environment sets `process.env.OMO_COWORKERS_ENABLE_WRITER_ROLE === "1"`. There is no per-turn prompt injection and no automatic file copier. **Operators using static dotfiles delivery should leave `OMO_COWORKERS_ENABLE_WRITER_ROLE` unset (off)** rather than enabling the legacy runtime transform alongside static dotfiles files.
- **Operator-opt-in Claude dispatch guard (`OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`, default OFF and independent)** — `openchamber/plugin/index.mjs` wraps `plugins/claude-advisor/index.js` behind `process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD === "1"`. Process environment is operator authority (never session state or `ctx.options`), and both plugin gates are independent: by default, with neither environment variable set to `"1"`, `openchamber/plugin/index.mjs` is a no-op during `setup(ctx)`. The standalone `plugins/claude-advisor/index.v1.mjs` and `plugins/claude-advisor/index.js` entries remain in the repository for separately managed local/dotfiles deployments.
- **Retired `3.x` installer, root overlay, and `lark-operator` files remain absent (breaking change from `3.x`)** — `bin/coworkers-install.mjs`, `installer/`, `prompts/document-writer.md`, `prompts/lark-operator.md`, and the root `oh-my-opencode-slim.json` overlay are not restored. This extension never writes user role files on disk and does not ship or configure `lark-operator` or role identity/permissions/models. Local role and OMO configuration files (such as [dotfiles/opencode](https://github.com/LittleKey/dotfiles/tree/master/opencode)) remain the authority for `document-writer` (identity, model, permissions, skill grants, and static prompt/routing files), `lark-operator`, and general OMO configuration.
- **Supervisor plugin stays separate (`plugins/supervisor/`, `bin/supervisor-memory.mjs`)** — the L0 `supervisor-nudge` plugin and `supervisor-memory` CLI (`package.json` `bin: { "supervisor-memory": "./bin/supervisor-memory.mjs" }`) remain in this repository as a separate plugin/CLI surface and are **not** loaded or enabled by the OpenChamber extension entry (`openchamber/plugin/index.mjs`). See [`plugins/supervisor/README.md`](plugins/supervisor/README.md).

## Layout (`v4.0.0`)

```
package.json               Root OpenChamber 2.7.2+ extension manifest (v4.0.0; panel id: omo-coworkers; bin: supervisor-memory)
openchamber/plugin/
  package.json             Nested ESM plugin manifest (omo-coworkers-openchamber-plugin v4.0.0)
  index.mjs                OpenChamber V2 plugin entry (both features default off; independent exact "1" env gates for OMO_COWORKERS_ENABLE_WRITER_ROLE and OMO_COWORKERS_ENABLE_CLAUDE_GUARD)
  writer-role.mjs          Legacy opt-in setup-time frozen payload loader, SHA-256 verifier, preflight, and native ctx.agent.transform registration
  roles/
    document-writer.md     Frozen upstream document-writer system prompt payload
    routing.json           Frozen upstream routing payload (writer description + orchestratorPrompt)
    audience.md            Frozen upstream orchestrator # Audience and dispatch section payload
    oracle-line.txt        Frozen upstream oracle editorial routing line payload
skills/                    3 portable skill directories: maintaining-product-engineering-docs, domain-modeling, humanizer
plugins/
  claude-advisor/          Stateless Claude dispatch guard (guard.mjs, index.js, index.v1.mjs, guard.test.mjs, README.md)
  supervisor/              Separate supervisor-nudge L0 plugin & supervisor-memory store/CLI implementation (not part of the OpenChamber extension entry)
bin/supervisor-memory.mjs  CLI entry for supervisor-memory
test/
  writer-role.test.mjs          Direct writer transform unit tests (frozen hashes, field preservation, legacy/native migration, conflicts, guard independence)
  openchamber-package.test.mjs  Relocated package payload, 20-case writer/guard cold-load env matrix, damaged-payload & optional installed-host parser verification
README.md / INSTALL.md / SOURCES.md / LICENSE
```

## Requirements, Delivery Stages & Boundaries

- **Distinct delivery stages (source edits ≠ git commit ≠ dotfiles snapshot update ≠ staged/live installation ≠ remote extension update)**:
  - Editing or committing this repository does **not** automatically update `dotfiles/opencode`, stage or activate configuration in `~/.config/opencode`, publish commits to GitHub, or update an installed OpenChamber extension.
  - Consuming updated `openchamber/plugin/roles/*` payloads in `dotfiles/opencode` requires committing the reviewed changes in `omo-coworkers`, updating any reviewed payload SHA-256 pins in `dotfiles/opencode/runtime/lib/writer-role-update.mjs` when payload bytes change, running `node opencode/runtime/bin/update-writer-role.mjs /path/to/local/omo-coworkers <FULL_40_HEX_COMMIT>`, and separately staging/activating the dotfiles profile.
  - Because `package.json` remains at version `4.0.0` until a separately authorized release bump, working-tree edits or same-version commits are not detected as updates by OpenChamber's semver update checker.
- **OpenChamber 2.7.2+** (`engines.openchamber: ">=2.7.2"`, Node `>=20`):
  - Install from the repository root Git URL in OpenChamber (`https://github.com/LittleKey/omo-coworkers.git` or `https://github.com/LittleKey/omo-coworkers.git#<branch-or-tag>`). OpenChamber Git URL installation supports only the repository root and an optional `#<branch-or-tag>` ref (no subdirectory syntax). The root package is prebuilt and committed with zero npm dependencies and no install/build hooks.
  - **Upstream update checks**: OpenChamber checks for updates only by comparing a newer root `package.json` semver version (not individual commits on the same version), caches checks for one hour, and requires a separate manual user apply action (no automatic updates).
- **Uninstall semantics & collision boundary**:
  - **Uninstalling or disabling the extension**: removes the extension's contributed skills and any opted-in plugin hooks after the host refreshes or restarts its OpenCode plugin lifecycle. It **never deletes or modifies static role, prompt, or configuration files managed by `dotfiles/opencode`** (nor does it delete an existing `document-writer` role).
  - **Existing installed files & duplicate registrations**: updating or cloning this repository does **not** modify or delete files previously deployed by `3.x`. Existing globally installed skills (`domain-modeling`, `humanizer`, `maintaining-product-engineering-docs`) or an already-loaded `claude-advisor` plugin require an explicit operator ownership decision; operators using static `dotfiles/opencode` delivery should keep `OMO_COWORKERS_ENABLE_WRITER_ROLE` unset (off).

See [INSTALL.md](INSTALL.md) for prerequisites, static dotfiles consumption vs. legacy `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` opt-in, `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` opt-in, manual verification, and archived `3.x` historical uninstall reference. See [SOURCES.md](SOURCES.md) for current `4.0.0` provenance and labeled historical records from the `1.x`–`3.3.0` installer era.
