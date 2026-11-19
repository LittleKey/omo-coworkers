# omo-coworkers

**OpenChamber 2.7.2 extension (`v4.0.0`) shipping the three portable coworker skills and an operator-opt-in Claude dispatch guard; role and OMO configuration are managed separately in local configuration (such as dotfiles).**

「面向 OpenChamber 2.7.2 的精简扩展包：提供三项通用协作技能与可选启用的 Claude 派发守卫；角色定义与 OMO 编排配置已迁回本地 dotfiles 独立管理。」

## What `v4.0.0` ships (and what moved out)

Starting in `4.0.0`, `omo-coworkers` is a root-level OpenChamber 2.7.2 extension (`panel.id: "omo-coworkers"`) rather than a role/overlay installer:

- **Bundled skills (`contributes.skills: "skills"`)** — ships the three portable skill directories verbatim:
  - `skills/maintaining-product-engineering-docs`
  - `skills/domain-modeling`
  - `skills/humanizer`
  No `lark-*` skills and no project-private skills are vendored.
- **Operator-opt-in Claude dispatch guard (`contributes.opencodePlugin: "openchamber/plugin"`)** — `openchamber/plugin/index.mjs` wraps `plugins/claude-advisor/index.js`. By default it is **off** (a no-op during `setup(ctx)` unless the operator process environment sets `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1`). Process environment is operator authority, never session or plugin options. The standalone `plugins/claude-advisor/index.v1.mjs` and `plugins/claude-advisor/index.js` entries remain in the repository for separately managed local/dotfiles deployments.
- **Role prompts, OMO overlay, and the `coworkers-install` / `dw-install` CLI are retired from this package (breaking change from `3.x`)** — `bin/coworkers-install.mjs`, `installer/`, `prompts/document-writer.md`, `prompts/lark-operator.md`, and the root `oh-my-opencode-slim.json` overlay have been removed. This extension does **not** ship, install, or configure `document-writer`, `lark-operator`, or builtin-role appends. Local role and OMO configuration files (for example, in the operator's personal [dotfiles/opencode](https://github.com/LittleKey/dotfiles/tree/master/opencode)) are the sole authority for agent roles and OMO overlays.
- **Supervisor plugin stays separate (`plugins/supervisor/`, `bin/supervisor-memory.mjs`)** — the L0 `supervisor-nudge` plugin and `supervisor-memory` CLI (`package.json` `bin: { "supervisor-memory": "./bin/supervisor-memory.mjs" }`) remain in this repository as a separate plugin/CLI surface and are **not** loaded or enabled by the OpenChamber extension entry (`openchamber/plugin/index.mjs`). See [`plugins/supervisor/README.md`](plugins/supervisor/README.md).

## Layout (`v4.0.0`)

```
package.json               Root OpenChamber 2.7.2 extension manifest (v4.0.0; panel id: omo-coworkers; bin: supervisor-memory)
openchamber/plugin/
  package.json             Nested ESM plugin manifest (omo-coworkers-openchamber-plugin v4.0.0)
  index.mjs                OpenChamber V2 plugin wrapper (no-op unless process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD === "1")
skills/                    3 portable skill directories: maintaining-product-engineering-docs, domain-modeling, humanizer
plugins/
  claude-advisor/          Stateless Claude dispatch guard (guard.mjs, index.js, index.v1.mjs, guard.test.mjs, README.md)
  supervisor/              Separate supervisor-nudge L0 plugin & supervisor-memory store/CLI implementation (not part of the OpenChamber extension entry)
bin/supervisor-memory.mjs  CLI entry for supervisor-memory
test/
  openchamber-package.test.mjs  OpenChamber 2.7.2 guest-package parser & cold-load env-gate verification
README.md / INSTALL.md / SOURCES.md / LICENSE
```

## Requirements & Installation Summary

- **OpenChamber 2.7.2+** (`engines.openchamber: ">=2.7.2"`, Node `>=20`):
  - Once the `4.0.0` release commit is pushed to GitHub, install via the repository root Git URL in OpenChamber 2.7.2:
    `https://github.com/LittleKey/omo-coworkers.git` (or `https://github.com/LittleKey/omo-coworkers.git#<branch-or-tag>`)
  - OpenChamber Git URL installation supports only the repository root and an optional `#<branch-or-tag>` ref (no subdirectory syntax). The root package is prebuilt and committed with zero npm dependencies and no install/build hooks. Do not treat the remote Git URL as active for `4.0.0` until the commit is pushed to the remote repository.
  - **Upstream update checks**: OpenChamber 2.7.2 checks for updates only by comparing a newer root `package.json` semver version (not individual commits), caches checks for one hour, and requires a separate manual user apply action (no automatic updates).
- **Existing installed files & collision/migration boundary**:
  - Updating or cloning this repository does **not** touch or automatically delete any files previously deployed by `3.x` (`~/.config/opencode/` or project `.opencode/` agent files, OMO prompts/overlays, `skills/maintaining-product-engineering-docs`, `skills/domain-modeling`, `skills/humanizer`, or `.opencode/plugins/claude-advisor.mjs`).
  - Existing globally installed skills (`domain-modeling`, `humanizer`, `maintaining-product-engineering-docs`) or an already-loaded `claude-advisor` plugin can collide with the OpenChamber extension's contributed skills or opt-in guard. OpenChamber/OpenCode does not promise silent loader precedence across duplicate skill/plugin registrations: activating the `4.0.0` extension on a machine with legacy deployed copies requires a separate operator migration and ownership decision, and neither the extension nor this repo ever deletes deployed copies automatically.

See [INSTALL.md](INSTALL.md) for OpenChamber 2.7.2 Git URL installation, `OMO_COWORKERS_ENABLE_CLAUDE_GUARD=1` opt-in, collision and migration handling, and archived `3.x` historical uninstall reference. See [SOURCES.md](SOURCES.md) for current `4.0.0` provenance and labeled historical records from the `1.x`–`3.3.0` installer era.
