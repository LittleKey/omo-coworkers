# Install (omo-coworkers 3.3.0 — dual-host installer)

The `omo-coworkers` package ships `bin/coworkers-install.mjs`, a host-aware additive installer (npm bin `coworkers-install`; the `dw-install` command is retained as a compatibility alias pointing to the same script). One command installs the two role agents and the three bundled skills into an OpenCode project on either host flavor — or at user level with `--global` (§11) — records a machine-readable manifest, and reverses its own writes — `uninstall` reverses managed content while intentionally preserving everything else, and `rollback` restores the recorded pre-install bytes of backed-up content; neither is an exact whole-filesystem reversal (§4). It never switches the preset, pins models, overwrites unrelated configuration, or writes through hard links.

Supported hosts, by what was actually run — keep the records distinct:

| Host flavor | Supported | Installer-level runtime checks ran on | Notes |
| --- | --- | --- | --- |
| v1 | stable OpenCode ≥ 1.18.29 within major 1 | 1.18.33, 1.18.35 | dual plugin entrypoints require ≥ 1.18.29; older v1 is rejected |
| v2 | stable OpenCode ≥ 2.0.20 within major 2 | 2.0.20 | 2.0.19 and below sit below the initial v2 installation floor; other stable ≥ 2.0.20 versions are a supported configuration whose installer-level runtime checks have not been run here; as of 2026-10-14 a v2 live re-run is not reproducible from public distribution channels — the 2.0.20 evidence is historical |

Unknown major versions and pre-release versions are rejected outright and never silently counted as supported. A version that merely matches the "ran on" column is evidence of installer-level checks only (role registration, prompt body, effective permissions, install/verify/uninstall loop — §7); it is **not** a claim of full release acceptance.

- Historical end-to-end baseline: oh-my-opencode-slim **2.2.21** on OpenCode **1.18.31** (full manual e2e run at that time).
- Portable load test (2026-09-30): oh-my-opencode-slim **2.2.25** / OpenCode **1.18.33**, overlay loaded in a fresh configuration with zero model calls (`/tmp/opencode/orchestration-refresh/live/portable-final/PASS.json`; overlay SHA-256 `bb1ab25827469fc6e6963b2219f69a69da24ad1f6fa63d56496d02e30d19ce08`). That was the pre-installer overlay; not a full install–uninstall exercise.
- Installer-level runtime checks for this installer (2026-09-30): see §7.

## 1. What the installer writes

For host flavor **v1** (agent dir `.opencode/agent/`, skill dir `.opencode/skill/`) or **v2** (`.opencode/agents/`, `.opencode/skills/`):

1. **Role agents** — `document-writer.md` and `lark-operator.md` as host-native agent files. The body after frontmatter is byte-identical to `prompts/document-writer.md` / `prompts/lark-operator.md` (prompt authority; the renderer owns frontmatter). Permissions are rendered in each host's native vocabulary, validated on the installer-level runtime-tested hosts:
   - v1: grouped frontmatter `permission:` map (`bash`, `task`, `edit`, …).
   - v2: ordered `permissions:` array of `{action, resource, effect}` with the 2.0 action names (`task`→`subagent`, `bash`→`shell`; `read`/`edit`/`write`/`glob`/`grep`/`question`/`webfetch`/`websearch` pass through; MCP tools assert as `<server>_<tool>` patterns).
   - document-writer denies delegation, question, webfetch, websearch, and research MCP tools; lark-operator allows read/glob/grep/webfetch/shell and denies edit, write, delegation, question, websearch, patch tools, and research MCP tools.
2. **Skills** — the three bundled directories (`maintaining-product-engineering-docs`, `domain-modeling`, `humanizer`) copied byte-for-byte into the host-native skill dir. The formerly bundled `writing-plans` was removed on 2026-10-11 and is never created by fresh installs or reinstalls; targets upgraded from the older four-skill package need the explicit handling described in §4. **No `lark-*` skills and no private skills are vendored**; personal model pins and the personal Orchestrator exclusion guardrails are not carried (they live in the owner's dotfiles configuration).
3. **OMO overlay** — `.opencode/oh-my-opencode-slim.json`, additive: the installer manages exactly `agents["document-writer"]` and `agents["lark-operator"]` (OMO-schema vocabulary — `inheritModelFrom: "session"`, skill grants, `orchestratorPrompt` dispatch rules, `permission` map — translated by the plugin per host). Every other **semantic value** of target-managed config is preserved through a structured merge: unknown top-level keys, other agents, presets, and unknown keys inside the two managed entries. The merged overlay is re-serialized (2-space JSON with a trailing newline), so the original byte layout is **not** preserved — only non-overlay files are byte-exact. The overlay carries no `prompt`/system text and no OMO prompt-dir copies are written, so each role's effective prompt is the native agent file (observed on both installer-level runtime-tested hosts **without the OMO plugin loaded**: v1 1.18.33 `debug agent <name>` shows the body as `prompt`; v2 2.0.20 `/api/agent` shows it as `system`; combined native+OMO precedence was not established by these checks).
4. **Plugin payload** — `<target>/.opencode/plugins/claude-advisor.mjs`: the managed path is identical on either host, but the source entry is selected by host flavor — v1 installs a verbatim byte-copy of `plugins/claude-advisor/index.v1.mjs`, v2 of `plugins/claude-advisor/index.js` (`guard.test.mjs` is not shipped). `.opencode/plugins/` is created when missing and, like skill dirs, pruned when empty after uninstall.
5. **Manifest** — `.opencode/omo-coworkers-install.json` (schemaVersion 1): package baseline, host flavor + detected version, per-file actions with installed SHA-256s (the plugin payload is recorded as a `files[]` entry with `kind: "plugin"`), overlay action + backup pointer, prompt-authority paths, skill list. Consumed by `uninstall`, `rollback`, and `verify`.

### Builtin-role appends across machines

The five builtin-role appends have one maintenance source: [dotfiles/opencode/oh-my-opencode-slim](https://github.com/LittleKey/dotfiles/tree/master/opencode/oh-my-opencode-slim), with `designer_append.md`, `explorer_append.md`, `librarian_append.md`, `oracle_append.md` and `orchestrator_append.md`. This repository contains no mirrors. `coworkers-install` installs the two custom-role bodies and skills described above; it neither supplies nor updates builtin-role appends.

For machines that share the personal OMO policy, select the same dotfiles commit and use its `opencode/runtime/profile.json` prompt hashes. Point that machine's `inputs.omoPromptDir.source` at its own checkout's `opencode/oh-my-opencode-slim` directory. Relocating a checkout changes the path, not the approved content or hashes. The personal runtime verifies the pinned inventory before staging and copies accepted prompt bytes unchanged. Install through the target's existing OMO/profile deployment, then compare the five installed file hashes with that same inventory. Do not edit installed copies or create a new mirror in this package.

The full personal runtime still has machine-specific configuration, plugin artifacts and activation ownership; see its [README](https://github.com/LittleKey/dotfiles/blob/master/opencode/runtime/README.md#prompt-ownership-and-multi-host-consistency) before using it on another machine. Matching file hashes establish append-byte consistency, not identical effective prompts: project/preset prompt files and inline overrides can change what OMO loads, so check the winning source on each target.

## 2. Usage

```sh
coworkers-install install                            # auto-detect host from `opencode --version`
coworkers-install install --host v2 --target ~/proj --opencode /path/to/opencode2
coworkers-install install --global                      # user-level install into the OpenCode config dir (§11)
coworkers-install plan      [...]                    # dry run — prints the artifact plan, writes nothing
coworkers-install verify    --target ~/proj          # manifest vs disk hashes → ok | drift | missing
coworkers-install uninstall --target ~/proj          # reverse everything the install wrote
coworkers-install rollback  --target ~/proj          # restore the exact pre-install state from backups
```

`coworkers-install` is the npm bin of the `omo-coworkers` package (run it as `npx coworkers-install …`); from a repository checkout, `node bin/coworkers-install.mjs …` is equivalent. The `dw-install` command remains as a compatibility alias pointing to the same script.

Flags: `--host v1|v2` (skip detection), `--opencode <exe>` (detection executable, default `opencode` on PATH), `--target <dir>` (default cwd), `--global` (user-level install mode; mutually exclusive with `--target` — exit 1; §11), `--config-dir <dir>` (config dir for `--global`, default `$OPENCODE_CONFIG_DIR` or `~/.config/opencode`; §11), `--force`, `--json`. Exit codes: `0` ok · `1` usage · `2` conflict (nothing written) · `3` host detection failure · `4` no manifest (uninstall/rollback without an install).

Detection parses `semver` from `<exe> --version` (stdout+stderr). Requires Node ≥ 20.

## 3. Conflict and safety rules

- **Nothing is written unless the whole plan is conflict-free.** Any conflict aborts with exit 2 before the first write.
- **Conflicts** (exit 2): an unmanaged file exists at a managed path (`agent/`/`agents/<role>.md`, skill dirs, `plugins/claude-advisor.mjs`); a project `oh-my-opencode-slim.jsonc` exists (it shadows `.json` in the plugin's resolution, so an additive `.json` install would be inert — merge the fragment into the `.jsonc` manually); the existing overlay already defines a managed agent key; the overlay path is a symlink; the manifest pins a different host flavor than requested.
- **`--force`** takes over conflicting content only after recording byte-exact backups under `.opencode/omo-coworkers-backup/<stamp>/`. Symlinks at managed paths are never replaced — they stay conflicts even with `--force` (link boundaries stay with the owner).
- **Hard-link write-through is impossible by construction**: every write is computed in full, written to a same-directory temp file, and committed with `rename()`, which swaps the directory entry to a fresh inode instead of writing through an existing link (the owner's deployment hard-links global and dotfiles copies of `opencode.json`/`oh-my-opencode-slim.json`). The consequence is intentional: external twins keep their original bytes and inode — never corrupted — while the managed path moves to a fresh inode, breaking the link relationship. The installer safely edits around existing hard links; it does **not** re-create or restore inode relationships (§4). Covered by dedicated regression tests.
- **Drift**: if a managed file changed since install, reinstall aborts (exit 2) without touching it; with `--force` the drifted content is backed up byte-exact and replaced. `verify` reports any drift.

## 4. Reversal

Neither command is an exact whole-filesystem reversal of the install — that is intentional.

- `uninstall` removes only the managed content: the two role files, the bundled skill dirs (only if unmodified), the plugin payload (only if unmodified), the two overlay agent entries (empty `agents` collapses), and the manifest. Created skill dirs that become empty are pruned; non-managed values are intentionally preserved — e.g. a created overlay keeps its `$schema` as a lazy file once the managed agents are removed, and an emptied role-agent directory is left in place. Files the owner changed after install are **kept** and reported; the manifest is retained with a pending-reconciliation record until they are removed. `replace` backups taken by `--force` — and the pre-install overlay backup — are restored only when the path still matches its installed hash recorded at install time; a drifted path is kept and reported instead, and a manifest without recorded hashes restores with an explicit warning that drift could not be verified.
- `rollback` restores the recorded pre-install bytes of everything the install backed up (overlay and the plugin payload included) and deletes created files; it is blocked (reported, nothing done for that path) for paths that are symlinks or drifted — drift meaning the current bytes differ from the installed hash recorded at install time. A path already holding its recorded pre-install bytes counts as restored, and a manifest without recorded hashes cannot be drift-checked: its rollback proceeds with an explicit warning. It restores **bytes, not inode/link topology**: a hard-linked file that was merged comes back with the original bytes on a fresh inode while external twins keep their own untouched copies — the link relationship is not re-created. Rollback covers handled failures during the install run; crash/power-loss recovery is not tested and not claimed.

**Retired `writing-plans` and older installations (2026-10-11).** The package no longer bundles `writing-plans`, but upgrading does not remove a pre-existing copy: a target installed from the older four-skill package keeps its installed `writing-plans` directory through an in-place upgrade. The rewritten manifest omits it, so those files become unmanaged orphans that neither a later `uninstall` nor any later install touches (the stale copy also does not conflict with future installs). Deleting this repository or package does not clean older installations either. To remove it on an upgraded target, uninstall with the **old** package revision before upgrading (`node bin/dw-install.mjs uninstall --target <dir>`), or explicitly inspect and delete the retired skill directory (`<target>/.opencode/skill/writing-plans` on v1, `<target>/.opencode/skills/writing-plans` on v2). This describes installer behavior only; whether and when an existing target is migrated remains its owner's explicit decision — no automatic cleanup is performed by install, uninstall, or this documentation.

## 5. Effective-source and OMO-layer notes

Still true and worth checking on any target before installing (the installer refuses most dangerous cases; these concern the *plugin* layer):

1. The plugin resolves user config from `$OPENCODE_CONFIG_DIR` if set, else `~/.config/opencode`; within a dir `.jsonc` wins over `.json`. Project config (`.opencode/oh-my-opencode-slim.json{,c}`) merges over the user layer per-key.
2. A native agent definition (host or project `.opencode` `agent/`/`agents/` file, or the config's native `agent` key) covers its fields for that name regardless of plugin-layer files. This precedence statement describes each source's design; the §7 runtime checks observed the native files registering correctly **without the OMO plugin loaded**, so they do not by themselves prove combined native+OMO precedence — a first combined runtime validation was recorded 2026-10-14 on a project-scoped install with the real HOME (§7); the isolated clean-host variant remains blocked upstream. This installer *writes* native definitions — on a target that already defines `document-writer`/`lark-operator` natively, that file is a conflict, not a shadowed copy; reconcile deliberately (the owner's file is backed up under `--force`).
3. Both agents use `"inheritModelFrom": "session"` (supported in the omo-slim 2.2.x and 3.0.1 sources): they run on the session's model; no model IDs are pinned.
4. `OH_MY_OPENCODE_SLIM_PRESET` and preset selection are untouched; the managed agent entries merge over preset members per-key.

## 6. Optional Lark integration (manual, after install)

The package vendors no Lark skills; `lark-operator` installs capability-less (`"skills": []`) — harmless without integration. When integration is requested: install or update `lark-cli` by its own official method; inventory actually discoverable `lark-*` skills in a fresh session; grant only skills that pass vetting (role fit, stated prerequisites, available CLI/auth, least-privilege boundaries) by appending names to the winning `agents["lark-operator"].skills` array in the appropriate layer, recorded for later reversal. Never widen a permission beyond the prompt's stated boundary (WebFetch = official Feishu/Lark API documentation only), never use a shell bypass. Writer-side Lark body editing stays in document-writer and only under explicit user opt-in plus the pre-write gate. Every external operation still requires user authorization — grants wire capability, not consent.

## 7. Verification — what was actually run (2026-09-30)

Distinguish fixture-unit evidence from real-host evidence. The optional live-host checks are selected by pointing `OCW_V1_BIN` / `OCW_V2_BIN` at an OpenCode v1 / v2 executable (renamed from `DW_V1_BIN` / `DW_V2_BIN` in 3.0.0); without them the suite runs fixtures only:

- **Fixture suite** (`node --test`, 32 tests, isolated temp targets): additivity, idempotent reinstall, conflict aborts with zero writes, `--force` takeover with byte-exact backups, rollback recorded-byte restoration, uninstall reconciliation rules, cross-flavor manifest pinning, `.jsonc` shadow, drift handling, hard-link write-through protection (fixture twins), symlink conflicts, CLI exit codes/`--json`, merge semantics, version-boundary classification, rejected-version matrix (below the v2 floor, unknown majors, pre-releases), and explicit-host probing (`--host` + `--opencode` mismatch and nonzero-exit rejection; `--host` alone reported as version-not-verified offline format generation).
- **Live v1 1.18.33** (`OCW_V1_BIN=$(which opencode) node --test`): both agents register (`debug agent <name>`), mode `subagent`, prompt body byte-identical to the source prompt, and the effective permission array shows the rendered map (`task: deny`, `webfetch: deny` for document-writer; `bash: allow`, `edit/write: deny`, `webfetch: allow`, `websearch: deny` for lark-operator).
- **Live v1 1.18.35 (2026-10-14)**: the same assertions re-run from a clean `git archive HEAD` snapshot (commit `9c7578f`, the v3.1.0 tree) with `OCW_V1_BIN` at a real 1.18.35 binary and `node --test --test-name-pattern 'live v1'` — 1/1 pass (~5.4 s): verbatim prompt body and rendered permission map effective on the real isolated host, still **without the OMO plugin loaded**. The v2 live checks were not re-run — see the note in the host table above.
- **Real-host project-scoped install + combined-native+OMO session pass (2026-10-14, owner machine)**: `coworkers-install install --target ~/github/feishu --host v1 --opencode <OpenCode 1.18.33 real binary>` with the real HOME (OMO bridge plugin + user plugins loaded) — plan dry-run all-create; install wrote 26 files (2 agents at `.opencode/agent/`, 3 skills at `.opencode/skill/`, the plugin payload at `.opencode/plugins/claude-advisor.mjs`, the overlay `.opencode/oh-my-opencode-slim.json`) plus the manifest `.opencode/omo-coworkers-install.json`; `verify` → ok: 26 · drift: 0 · missing: 0. From the installed project cwd, one-shot live sessions worked with the OMO bridge loaded: `opencode run -m newapi/glm-5.3-flash "reply with exactly: OK"` exited 0 replying `OK`, and `opencode run --agent document-writer -m <model> "which skill names are granted"` exited 0 with the session's available-skills list containing the three project-installed skills and no `lark-*`/`yogo-products` grants (the project overlay, not the user-level superset, supplying the agent). This partially retires the "combined native+OMO never validated" risk for project scope. Scope note: executed and removed the same day at owner request (`coworkers-install uninstall --target ~/github/feishu` — all 26 entries removed, manifest cleaned); the owner's preference is a global (user-level) install mode, planned as follow-up work.
- **Live v2 2.0.20** (isolated `OCW_V2_BIN=… node --test`): the real 2.0.20 host served in a fully isolated environment (own HOME/XDG/DB/plugin-cache; **zero model requests**; production untouched; **no OMO plugin installed**). `GET /api/agent` after session hydration: exactly **one** registration per role in that environment (no duplicate; since the plugin layer was not loaded there, this does not establish combined native+OMO precedence — owner-validated separately), `system` is the verbatim prompt body, and the effective `permissions` array carries the rendered v2 vocabulary (document-writer: `subagent`/`question`/`webfetch`/`websearch`/`gh_grep_*`/`context7_*` deny; lark-operator: `read`/`glob`/`grep`/`webfetch`/`shell` allow, `edit`/`write`/`subagent`/`question`/`websearch`/`apply_patch`/`ast_grep_replace` deny).
- Known environment limit: the v2 CLI subcommand `debug agents` does not terminate in this sandbox (hangs with no output even outside an install), so the v2 live check drives the host server API instead — the same registration path the TUI uses.
- **`debug agent` stall with a project overlay present (2026-10-14)**: `opencode debug agent <name>` — and debug subcommands generally — stalls when the cwd contains a project overlay install (reproduced with the real HOME at the installed project — timeout kill, zero output — and earlier in isolated homes), while real sessions (`opencode run`, including `--agent`) work fine from the same cwd. The stall is specific to the debug subcommand's config-loading path, not a functional break of installed projects. Verify agent wiring with `opencode run --agent <role> "…"` (or any real session), not `debug agent`.

Run the same acceptance on your own target and record it here. `uninstall` then `verify` (expect exit 4: no manifest) closes the loop on a disposable target.

## 8. Requirements

- Stable OpenCode v1 ≥ 1.18.29 within major 1, or v2 ≥ 2.0.20 within major 2 (see table above; unknown majors and pre-releases are rejected) with the oh-my-opencode-slim plugin installed and loaded for the OMO overlay to take effect; the native role agents and skills register with the host alone.
- Node ≥ 20 for the installer. Lark features are optional (§6).

## 9. Migrating from ≤2.x

The 3.0.0 rename (package `omo-coworkers`) changed the installer's on-disk names:

- Install manifest: `.opencode/document-writer-install.json` (≤2.x) → `.opencode/omo-coworkers-install.json` (3.0.0).
- Backup directory: `.opencode/document-writer-backup/` (≤2.x) → `.opencode/omo-coworkers-backup/` (3.0.0).

The 3.0.0 installer tracks only the new names. An existing ≤2.x install must therefore be uninstalled with the **old** package revision before installing 3.0.0 (from the old checkout: `node bin/dw-install.mjs uninstall --target <dir>`); installing 3.0.0 over a leftover ≤2.x install would leave that install orphaned — its managed content stays on disk with no manifest the 3.0.0 installer tracks. This is the same policy applied when `writing-plans` was retired (§4).

## 10. Upgrading from 3.0.0

The 3.1.0 plugin payload (§1 item 4) is new, and the rename-related steps of §9 already covered older targets. Verified in-place path (2026-10-14): reinstalling 3.1.0 over an existing 3.0.0 install whose manifest lacks the plugin record proceeded without conflict — reinstall reported the 25 existing files `unchanged` plus one `create` for `.opencode/plugins/claude-advisor.mjs`, and a following `verify` reported ok 26 · drift 0 · missing 0, with the regenerated manifest ending in the plugin record. Clean alternative: `uninstall` the 3.0.0 install first, then run a fresh 3.1.0 install.

## 11. Global (user-level) install (3.3.0)

`coworkers-install install|plan|verify|uninstall|rollback --global [--config-dir <dir>] [--force]` installs at user level instead of into a project. `--global` and `--target` are mutually exclusive (combining them is a usage error, exit 1). `--config-dir` is valid only with `--global` and defaults to `$OPENCODE_CONFIG_DIR` or `~/.config/opencode`.

What lands where, relative to the config dir:

- Prompt bodies → `oh-my-opencode-slim/<role>.md`, verbatim copies of the repo prompts.
- The three skills → `skills/<name>/` (plural, host-native layout).
- Overlay → `oh-my-opencode-slim.json`: created wholesale if absent; additively merged if present but free of managed agent keys; **preserved completely untouched — even with `--force`** — with a recorded notice when it already defines `document-writer` or `lark-operator` (owner-curated config is never rewritten in global mode).
- The claude-advisor plugin is **never** installed in global mode: user-level auto-load would require an explicit `plugin` entry in the owner's `opencode.json`, and the installer does not edit personal config. The skip is recorded as a notice; the plugin stays project-scoped (§1 item 4).
- Manifest → `omo-coworkers-install.json` in the config dir — same schemaVersion 1 — gaining `scope: "global" | "project"` (absent reads as project) and an advisory `notices[]` array that `verify` re-surfaces.
- Backups → `omo-coworkers-backup/<stamp>/` in the config dir.

Pre-existing files or directories that are byte-identical to the payload are **adopted** (zero writes, hash recorded) rather than rewritten or flagged as conflicts. Also fixed in 3.3.0 for both modes: `uninstall` of an overlay the installer itself *created* now hash-gate-deletes the whole file instead of unmerging (previously a created overlay's uninstall left a `$schema`-only residue).

v2 hosts use the same global surfaces; the recorded global-mode evidence is a v1 real-host run (§7), with v2 covered by fixtures — the host table's "v2 evidence historical" framing is unchanged.

Operational notes:

- After a global prompt update, a running OpenCode server may keep the previously loaded prompts until it is restarted.
- A host-native `agents/<role>.md`/`.markdown` file the user created earlier overrides the OMO prompt file for that role. Reconcile by hand if needed: preserve the file's frontmatter (e.g. `mode`/`description`/`model`/`variant`) and replace only the body with the repo prompt — the installer never touches those files (observed 2026-10-15: the owner's old `lark-operator.md` body kept winning until manually reconciled; see SOURCES.md).
- Probing subagents: `opencode run --agent <role>` in v1 falls back to the default agent for subagent roles ("agent '<role>' is a subagent, not a primary agent"); subagent prompts are not directly probeable this way. This corrects the inference drawn from the 2026-10-14 project E2E (§7), whose valid signals (clean session spawn with the overlay, project skills in the available-skills list) stand.
