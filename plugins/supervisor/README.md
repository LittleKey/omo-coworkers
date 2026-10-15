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
    ["/abs/path/plugins/supervisor/index.mjs", { "mode": "observe" }]
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
