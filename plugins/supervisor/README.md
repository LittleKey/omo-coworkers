# supervisor-nudge (L0)

opencode plugin: bounded supervisor that observes a root orchestrator session
and, in `inject` mode, may append one deterministic pre-request nudge to the
model context. Authoritative spec: `docs/supervisor-nudge-design-v2.md` —
this implementation covers the L0 scope only (rule families A/B, no LLM, no
wakers, no promptAsync).

## Install / configure

In `opencode.json` (options come via the plugin tuple's second element):

```json
{
  "plugin": [
    ["/abs/path/plugins/supervisor/index.v1.mjs", { "mode": "observe" }]
  ]
}
```

The default export is the plugin factory; it returns the hooks object
directly. Exactly two hooks are registered:

| hook | role |
|---|---|
| `event` (catch-all) | single observation source: sessions, user turns, adviser calls, todowrites, task terminal signals, discard stats |
| `experimental.chat.messages.transform` | single injection point: T1a bounded evaluation + (inject mode) at most one appended synthetic user message |

## Modes

| mode | behavior |
|---|---|
| `observe` (default, phase one) | log-only. Zero injection, zero wake-ups, zero LLM. Rule evaluation results go to the observe log. |
| `inject` (phase two) | after evaluation, appends **one** `[supervisor-nudge]`-prefixed synthetic user message per model request when a valid candidate exists. Never rewrites existing parts. "injected" only means *joined this request's context* — not provider success, not orchestrator adoption. |

Options:

| option | default | meaning |
|---|---|---|
| `mode` | `observe` | `observe` \| `inject` |
| `injectPerSessionMax` | `3` | per-session injection budget |
| `nudgeMaxChars` | `1200` | single nudge length cap |
| `sessionLruMax` | `200` | session ledger LRU bound |
| `ringBufferMax` | `500` | per-session event ring buffer |
| `logMaxBytes` | `5242880` | observe log rotation size (keeps one `.1` generation) |
| `logPath` | `~/.local/share/opencode/storage/plugin/supervisor/log.jsonl` | observe log (JSONL) |
| `candidatesCap` | `20` | per-session candidate list bound |
| `assistantDecisionsStale` | `2` | rule B1: assistant decisions after a task-terminal signal without a todowrite |
| `turnsDormant` | `2` | rule B2: user turns an in_progress todo may stay untouched |
| `evidenceMaxChars` | `200` | signal snippet cap inside a nudge |

## What is observed (and filtered)

Only root orchestrator sessions count. Filtered (and counted as discard
reasons): OMO `subagent.*` child sessions, `councillor-*`/judge-named
sessions, sessions with a `parentID`, user messages carrying
`internalInitiator` / `backgroundJobBoard` / `phaseReminder` / `deepworkGoal`
metadata, and synthetic text (`[system-reminder`, `[blackboard`, `[ACP`,
`bcp`, `SLIM_INTERNAL_INITIATOR`, `Background Job Board`, `PHASE_REMINDER`,
`dcp` markers). Any `message.removed`/part-revert or `session.compacted`
latches the session *unstable*: candidates expire and the transform hook
fails safe (no intervention).

## L0 rule families

- **A `oracle_dispatch`** — high-stakes signal in the current real user turn
  (credential paths, irreversible commands like `rm -rf` / `git push -f` /
  `DROP TABLE` / `chmod 777`, contract files like `package.json` / API
  schema, approval/SLA keywords) **× zero adviser calls in the current turn**.
  Signal present but an adviser (oracle/council/claude/`councillor-*`) was
  already called → discard `adviser_already_called`.
- **B `todo_stale`** —
  B1 *completion-sync*: a task terminal signal (`<task …state="completed">`
  delivery or background-terminal text) with open todo items still on the
  ledger and ≥2 assistant decisions without any todowrite since the signal;
  B2 *dormancy*: an in_progress todo untouched across ≥2 user turns.

## Candidate lifecycle

`candidate → injected | expired`. Binding =
`(sessionId, userTurnId, turnCount, evidenceHash)`. New real user input or an
evidence change expires all open candidates; the same binding + ruleId
dedupes; nothing is re-injected across turns. Injection time re-validates the
binding before appending.

## Phase mapping

- Phase one (L0 rollout) = `mode: "observe"` — validate signals/discards via
  the log, zero model-visible behavior.
- Phase two = `mode: "inject"` — the single minimal L0 intervention.

## Memory (supervisor-memory M1, P1 store)

`lib/memory/store.mjs` is the unified memory store for supervisor-memory
(m1-plan: `docs/supervisor-memory-m1-plan.md`, design:
`docs/supervisor-memory-design.md`). Pure file storage, zero external
dependencies, plain ESM (`.mjs`), runnable under both Bun (plugin runtime)
and node ≥ 20 (CLI/tests).

### Unified root

Everything lives under **one** directory:

```
~/.local/share/opencode-supervisor/memory/
  rules.json       active + disabled rules (versioned, scope, approvalRef)
  issues.json      correction candidates + human triage state
  events.jsonl     correction events with evidence snapshots (append-only)
  decisions.jsonl  approve / reject / disable / enable records (append-only)
  projects.json    host project ids, human aliases, confirmed directories
  digest/          derived views only (never authoritative)
```

**Backup = copy this one directory.** v1 has no rebuild command; the only
recovery for a damaged store is restoring a backup. The store must not be
re-created behind the tools' back: a missing store is an error, not a fresh
install. First-time creation is explicit:

```sh
node -e 'import("./plugins/supervisor/lib/memory/store.mjs").then(m => m.initStore())'
```

`initStore()` creates the directory with mode `0700` and every file with mode
`0600`, plus an empty skeleton and a committed marker.

### Sensitivity

Correction events embed **verbatim excerpts of real session messages** (short
evidence snapshots with timestamps and source references). Treat the whole
directory as sensitive session content: `0600`/`0700` permissions are a hard
requirement (the doctor refuses to run healthy against looser modes), and
backups inherit the same sensitivity.

### Failure behavior (fail-closed, decision D5)

- All writes go through a single whole-store lock and a fixed cross-file
  commit order: `decisions.jsonl` → state files → `commit.marker`
  (pending → committed, with per-file expected sha256). A crash mid-commit
  leaves a detectable incomplete state.
- On reopen, an incomplete commit **closes all authorization outputs**: no
  publishing, no cleanup patches, no state changes. The diff (which files
  landed, which did not) is reported for human review and stays visible until
  a human resolves it.
- Corrupt files, truncated logs, unknown schema versions, permission errors,
  live lock conflicts, or a missing store → the operation is refused. The
  store never re-roots itself elsewhere, never auto-repairs, never rebuilds
  `active` rules from historical approvals, and never overwrites on a lock
  conflict (multi-instance safe: second writer fails with `STORE_LOCKED`).
- A live lock holder (fresh heartbeat from a running process) blocks writers
  until the timeout; a provably dead holder (dead PID / stale heartbeat) is
  recovered automatically after a short grace period.
- Diagnostics: `store.doctor()` is a read-only health check (file presence,
  parse, schema, marker-vs-content seq, permissions, lock state, incomplete
  commits). CLI commands must surface its findings instead of acting.

### CLI (`bin/supervisor-memory.mjs`)

The human-review CLI (P3) and the exact-patch printer (P4). The CLI is the
only trusted approval surface (design I.6): approvals are TTY-interactive,
bound to the approved object's hash, and the plugin itself keeps **zero
write access to target files** — a human always applies patches by hand.

```sh
supervisor-memory <command> [args] [--root <dir>]
```

Schema gate: at startup the CLI pre-checks the store's schema id/version and
refuses to run against an incompatible store (upgrade path: stop the old tool
version, back up the directory, upgrade CLI + store, then migrate).

| Command | Semantics |
| --- | --- |
| `init [--root <dir>]` | Explicitly create the store (default root `~/.local/share/opencode-supervisor/memory`); refuses to overwrite (`STORE_EXISTS`). |
| `digest` | Pending candidates + source excerpts + D9 read-only presence check + D10 weekly review. Read-only; no model calls. |
| `digest --draft <ISS-…>` | Draft a rule body for one candidate via the draft endpoint (see below). One attempt; failure/timeout never blocks digest. |
| `approve <ISS-…\|RUL-…>` | Three-stage TTY approval (D6): targets → full object review → confirm. Re-verifies the object hash and a store fingerprint at confirm time; any concurrent change invalidates the confirmation (no silent retry). On success prints the patch(es) — approval ≠ applied. |
| `discard <ISS-…\|EVT-…>` | Terminal state: candidate dropped / event marked false-positive. Re-reporting the same fact only duplicates the count, never revives authorization. |
| `merge <donor> <target>` | Human merges duplicate candidates; both events keep their original sources; merging grants no authorization and widens no scope. |
| `disable <RUL-…>` | Records the disable decision and prints removal patches for every known target. Stopping the rule in the store does NOT retract file residue — apply the removal patches by hand. |
| `status` / `doctor` | Human-readable read-only views; `doctor` includes the incomplete-commit diff report and exits 1 (authorization outputs stay closed) on unhealthy stores. |

#### The full loop

```sh
supervisor-memory init
# … supervisor plugin reports candidates while you work …
supervisor-memory digest
supervisor-memory digest --draft ISS-ab12cd34   # optional: model-drafted body
supervisor-memory approve ISS-ab12cd34          # 3-stage TTY review
#   → prints the exact patch; you paste it into the target AGENTS.md yourself
supervisor-memory digest                        # D9 check now shows 在场 / 待人工应用
```

A publish target must satisfy all three conditions (D8 + A2): the file
already exists, you confirm that exact file, and its load scope is verified —
OpenCode v2.1.2 loads only `AGENTS.md` files (global
`~/.config/opencode/AGENTS.md`, then the project's nearest-first from cwd; a
failing project file fails the whole instruction source). The CLI never
recommends `CLAUDE.md`, never creates new files, never falls back from a
subdirectory scope to the repo root, and never falls back to user-global.
If no compliant target exists, the candidate stays unpublished with the
reason printed.

#### Patch format (P4)

Patches are printed, never written. A managed segment is wrapped in a
per-rule per-version marker pair; bodies are capped at 10 lines (over-limit
fails whole, never truncated):

```
<!-- supervisor-memory:rule:RUL-xxxxxx:v2 -->
…rule body…
<!-- /supervisor-memory:rule:RUL-xxxxxx:v2 -->
```

Every patch carries its boundary notes: target path, why this target, the
scope promise, and git-tracking status. Three operations: add (append the
segment), replace (old segment → new segment), remove (delete the whole
segment). If a target no longer matches what was recorded (segment changed
or removed externally), the CLI says "target changed → human review" and
never infers "the user deleted it".

#### `digest --draft` endpoint

Environment variables: `SUPERVISOR_MEMORY_DRAFT_API_KEY` (no key → the step
is skipped with a note), `SUPERVISOR_MEMORY_DRAFT_BASE_URL` (default
`http://10.126.126.10:3000/v1`), `SUPERVISOR_MEMORY_DRAFT_MODEL` (default
`glm-5.3`). Outbound scope: exactly one request containing this candidate's
events + excerpts — never the rest of the store. One attempt, 30 s timeout;
failures/timeout are counted on the candidate and drafting falls back to
manual. The drafted body is stored in the rebuildable `digest/drafts.json`
view (the store itself has no draft field in M1), and adoption still requires
the full three-stage approval.

### Tests

```sh
node --test test/unit.test.mjs test/v2-context.test.mjs test/store.test.mjs test/cli.test.mjs
```

`test/store.test.mjs` covers the full T4 fault matrix (missing/corrupt/
truncated/permission/lock/unknown-schema rejection, per-operation crash
injection over every transaction-checklist step, idempotency, lock
recovery/refusal, init permissions) — always against temp directories; the
real `~/.local/share/opencode-supervisor/` is never touched. `test/cli.test.mjs`
covers the P3/P4 CLI: T3 (authorization race: store changed between stage 2
and stage 3 → confirmation invalidated; disable/re-approve/duplicate
report/merge/draft regen cannot revive authorization; non-TTY refused), T5
(target boundary: unconfirmed dirs, subdir scope, CLAUDE.md-only projects,
tracked files, >10-line bodies, externally changed targets), T6 (zero writes
to target files across all normal and error paths) and the `--draft` mock
endpoint (success / HTTP failure / timeout, request carries only the named
candidate).

## Tests

```sh
node --test test/unit.test.mjs  # unit tests (file form; directory form reports spurious errors)
node test/e2e.mjs observe       # isolated E2E, observe mode
node test/e2e.mjs inject        # isolated E2E, inject mode
```

E2E replicates the probe2 setup: isolated `$HOME` (copy of
`/tmp/opencode/probe2/home`, incl. npm cache + provider SDK), isolated
`OPENCODE_CONFIG`, clean-env `opencode serve`, and a local OpenAI-compatible
mock provider (`test/e2e-mock.mjs`, request capture reused from probe2's
pattern). The mock forces a tool loop so two main model requests occur within
one user turn — proving same-binding dedup end to end. Assertions include:
observe → zero supervisor markers in any captured provider request; inject →
exactly one `[supervisor-nudge]` in provider bodies, absent from
`GET /session/{id}/message` and `opencode.db`, title-generation requests
untouched.

## Known limitations

- Rule signals are regex/keyword based — precision over recall; new signal
  families need code changes (deterministic, bounded by design).
- L0 only: no oracle consultation, no memory/KV, no multi-nudge strategies,
  no per-rule budgets beyond the per-session cap.
- The injection lands in the provider request for the *current* turn only;
  nothing is persisted or replayed by design.
- `session.compacted`/revert handling is fail-safe (skip + expire), not
  post-compaction re-baselining.
- One `.1` log generation is kept on rotation; older evidence is gone.
- The observe log records `injected` as *added to request context*; delivery
  or model adoption is not tracked.
