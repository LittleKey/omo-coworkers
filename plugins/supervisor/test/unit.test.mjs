// Unit tests for supervisor-nudge L0 (node --test).
// Covers: filters, ledger updates, rule A/B hits & discards, candidate
// expiry/dedup, injection format & budget cap, observe-mode zero-injection.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  findSyntheticMarker,
  findInternalMetadataKey,
  isAdvisorSessionName,
  findTaskCompletedSignal,
} from "../lib/filter.mjs"
import {
  createLedger,
  freshRecord,
  newRealUserTurn,
  recordAdviserCall,
  recordAssistantDecision,
  recordTodowrite,
  recordTaskCompleted,
  evidenceHash,
  RingIdSet,
  isAdviserSubagent,
} from "../lib/ledger.mjs"
import { evaluateRuleA, evaluateRuleB, evaluateAllRules } from "../lib/rules.mjs"
import {
  offerCandidate,
  expireAll,
  isBindingValid,
  markInjected,
} from "../lib/candidates.mjs"
import { formatNudge, buildInjectedMessage } from "../lib/nudge.mjs"
import { resolveConfig } from "../lib/config.mjs"
import SupervisorNudge from "../index.mjs"

const CFG = resolveConfig({ logPath: path.join(os.tmpdir(), "sn-unit-unused.jsonl") })

// ---------- helpers ----------

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sn-test-"))
}

async function makePlugin(options = {}) {
  const dir = tmpdir()
  const logPath = path.join(dir, "log.jsonl")
  const hooks = await SupervisorNudge({}, { logPath, ...options })
  const readLog = () =>
    fs
      .existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : []
  return { hooks, logPath, readLog, dir }
}

function sessionEvent(hooks, sid, extra = {}) {
  return hooks.event({
    event: { type: "session.created", properties: { info: { id: sid, title: "New session", ...extra } } },
  })
}

function userTurnEvent(hooks, sid, messageId, info = {}) {
  return hooks.event({
    event: { type: "message.updated", properties: { info: { id: messageId, role: "user", sessionID: sid, ...info } } },
  })
}

function textPartEvent(hooks, sid, messageId, text) {
  return hooks.event({
    event: { type: "message.part.updated", properties: { part: { type: "text", messageID: messageId, sessionID: sid, text } } },
  })
}

function assistantEvent(hooks, sid, messageId) {
  return hooks.event({
    event: { type: "message.updated", properties: { info: { id: messageId, role: "assistant", sessionID: sid } } },
  })
}

// ---------- filters ----------

test("filter: synthetic markers detected", () => {
  for (const [text, marker] of [
    ["[system-reminder: hello]", "[system-reminder"],
    ["[blackboard] note", "[blackboard"],
    ["[ACP] something", "[ACP"],
    ["see bcp:store marker", "bcp"],
    ["SLIM_INTERNAL_INITIATOR=x", "SLIM_INTERNAL_INITIATOR"],
    ["Background Job Board digest", "Background Job Board"],
    ["PHASE_REMINDER fired", "PHASE_REMINDER"],
    ["dcp: status", "dcp"],
    ["(dcp) inline marker", "dcp"],
  ]) {
    assert.equal(findSyntheticMarker(text), marker, text)
  }
  assert.equal(findSyntheticMarker("please fix the bug in src/index.ts"), null)
  assert.equal(findSyntheticMarker(""), null)
  assert.equal(findSyntheticMarker(undefined), null)

  // Regression: `bcp` uses case-sensitive word-boundary matching — real
  // markers are lowercase ("bcp:store", "<!-- bcp"), while "BCP 47"
  // (language-tag spec) stays legitimate user text.
  assert.equal(findSyntheticMarker("normalize to BCP 47 language tags"), null)
  assert.equal(findSyntheticMarker("the bcp plugin may inject"), "bcp")
  assert.equal(findSyntheticMarker("nestedbcpword"), null)
})

test("filter: internal metadata keys detected (top-level and nested)", () => {
  assert.equal(findInternalMetadataKey({ id: "m1", internalInitiator: "x" }), "internalInitiator")
  assert.equal(findInternalMetadataKey({ id: "m1", metadata: { phaseReminder: true } }), "phaseReminder")
  assert.equal(findInternalMetadataKey({ id: "m1", metadata: { DEEPWORKGOAL: true } }), "deepworkGoal")
  assert.equal(findInternalMetadataKey({ id: "m1", role: "user" }), null)
  assert.equal(findInternalMetadataKey(null), null)
})

test("filter: advisor-named sessions", () => {
  assert.equal(isAdvisorSessionName("councillor-abc"), true)
  assert.equal(isAdvisorSessionName("Councillor-XYZ"), true)
  assert.equal(isAdvisorSessionName("judge panel"), true)
  assert.equal(isAdvisorSessionName("Fix the login bug"), false)
  assert.equal(isAdvisorSessionName(""), false)
  assert.equal(isAdvisorSessionName(undefined), false)
})

test("filter: task terminal signals", () => {
  assert.equal(findTaskCompletedSignal('<task id="7" state="completed">done</task>'), "task_delivery")
  assert.equal(findTaskCompletedSignal("background task #3 completed successfully"), "background_terminal")
  assert.equal(findTaskCompletedSignal("task 5 state: completed"), "task_state_line")
  assert.equal(findTaskCompletedSignal("task 5 state: running"), null)
  assert.equal(findTaskCompletedSignal("plain text"), null)
})

test("filter: adviser subagent names", () => {
  for (const ok of ["oracle", "council", "claude", "councillor-alpha", "councillor-12"]) {
    assert.equal(isAdviserSubagent(ok), true, ok)
  }
  for (const no of ["general", "researcher", "", undefined, "councillorish"]) {
    assert.equal(isAdviserSubagent(no), false, String(no))
  }
})

// ---------- ledger ----------

test("ledger: real user turns counted, per-turn state reset", () => {
  const rec = freshRecord("s1")
  assert.equal(newRealUserTurn(rec, "u1"), true)
  assert.equal(rec.turnCount, 1)
  assert.equal(rec.currentUserTurnId, "u1")
  recordAdviserCall(rec, "task", "oracle")
  assert.equal(rec.adviserCallsThisTurn, 1)
  assert.equal(newRealUserTurn(rec, "u1"), false) // same id: not a new turn
  assert.equal(rec.turnCount, 1)
  assert.equal(newRealUserTurn(rec, "u2"), true)
  assert.equal(rec.turnCount, 2)
  assert.equal(rec.adviserCallsThisTurn, 0) // reset per binding
})

test("ledger: assistant decisions counted once", () => {
  const rec = freshRecord("s1")
  recordAssistantDecision(rec, "a1")
  recordAssistantDecision(rec, "a1")
  recordAssistantDecision(rec, "a2")
  assert.equal(rec.assistantTurnCount, 2)
})

test("ledger: todowrite snapshot and task-completion signal", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  recordTodowrite(rec, [{ id: "1", status: "in_progress" }])
  assert.equal(rec.todowrites, 1)
  assert.equal(rec.lastTodo.todos[0].status, "in_progress")
  recordTaskCompleted(rec, "task_tool")
  assert.equal(rec.tasksCompleted, 1)
  assert.equal(rec.lastTaskCompleted.source, "task_tool")
})

test("ledger: evidence hash is stable and text-sensitive", () => {
  assert.equal(evidenceHash("abc"), evidenceHash("abc"))
  assert.notEqual(evidenceHash("abc"), evidenceHash("abd"))
  assert.equal(evidenceHash("").length, 16)
})

test("ledger: RingIdSet bounded", () => {
  const s = new RingIdSet(3)
  for (const id of ["a", "b", "c", "d"]) s.add(id)
  assert.equal(s.size, 3)
  assert.equal(s.has("a"), false)
  assert.equal(s.has("d"), true)
})

test("ledger: session LRU eviction", () => {
  const cfg = resolveConfig({ logPath: "/dev/null", sessionLruMax: 2 })
  const led = createLedger(cfg)
  led.ensure("s1")
  led.ensure("s2")
  led.recall("s1") // refresh recency
  led.ensure("s3") // evicts s2
  assert.equal(led.recall("s1")?.id, "s1")
  assert.equal(led.recall("s2"), null)
  assert.equal(led.recall("s3")?.id, "s3")
  assert.equal(led.size(), 2)
})

// ---------- rule A ----------

test("rule A: hit on high-stakes command with zero adviser calls", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "please run git push -f origin main for me"
  rec.currentEvidenceHash = evidenceHash(rec.currentUserText)
  const r = evaluateRuleA(rec)
  assert.equal(r.kind, "hit")
  assert.equal(r.ruleId, "A.oracle_dispatch")
  assert.equal(r.evidence.family, "irreversible_command")
})

test("rule A: credential path, contract file, SLA signals", () => {
  for (const [text, family] of [
    ["read ~/.ssh/id_rsa and tell me", "credential_path"],
    ["update package.json dependencies", "contract_file"],
    ["we need sign-off before go-live", "approval_sla"],
    ["chmod 777 /var/data", "irreversible_command"],
  ]) {
    const rec = freshRecord("s1")
    newRealUserTurn(rec, "u1")
    rec.currentUserText = text
    rec.currentEvidenceHash = evidenceHash(text)
    const r = evaluateRuleA(rec)
    assert.equal(r?.kind, "hit", text)
    assert.equal(r.evidence.family, family, text)
  }
})

test("rule A: discard when adviser already called this turn", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "run rm -rf /tmp/build"
  rec.currentEvidenceHash = evidenceHash(rec.currentUserText)
  recordAdviserCall(rec, "task", "oracle")
  const r = evaluateRuleA(rec)
  assert.equal(r.kind, "discard")
  assert.equal(r.reason, "adviser_already_called")
})

test("rule A: benign text → no result", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "fix the typo in README"
  rec.currentEvidenceHash = evidenceHash(rec.currentUserText)
  assert.equal(evaluateRuleA(rec), null)
})

// ---------- rule B ----------

function b1Setup() {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  recordTodowrite(rec, [
    { id: "1", status: "completed" },
    { id: "2", status: "in_progress" },
  ])
  recordAssistantDecision(rec, "a1")
  recordTaskCompleted(rec, "task_delivery")
  return rec
}

test("rule B1: completion-sync hit after 2 decisions without todowrite", () => {
  const rec = b1Setup()
  recordAssistantDecision(rec, "a2")
  recordAssistantDecision(rec, "a3")
  const r = evaluateRuleB(rec, CFG)
  assert.equal(r.kind, "hit")
  assert.equal(r.ruleId, "B.todo_stale")
  assert.equal(r.evidence.sub, "completion_sync")
  assert.equal(r.evidence.decisionsSince, 2)
  // signal resolved: evaluating again must NOT re-fire B1 (falls through to
  // B2 whose 2-turn dormancy gap is not met either) → null
  assert.equal(evaluateRuleB(rec, CFG), null)
})

test("rule B1: waits (null) before threshold, discards when todo updated", () => {
  const rec = b1Setup()
  recordAssistantDecision(rec, "a2") // only 1 decision since signal
  assert.equal(evaluateRuleB(rec, CFG), null)
  assert.equal(rec.lastTaskCompleted.resolved, false) // not consumed
  const rec2 = b1Setup()
  recordAssistantDecision(rec2, "a2")
  recordAssistantDecision(rec2, "a3")
  recordTodowrite(rec2, [{ id: "2", status: "in_progress" }]) // resync (still open items) before eval
  const r2 = evaluateRuleB(rec2, CFG)
  assert.equal(r2.kind, "discard")
  assert.equal(r2.reason, "todo_updated_since_signal")
})

test("rule B2: dormant in_progress todo over 2 user turns", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  recordTodowrite(rec, [{ id: "1", status: "in_progress" }])
  newRealUserTurn(rec, "u2")
  assert.equal(evaluateRuleB(rec, CFG), null) // 1 turn gap
  newRealUserTurn(rec, "u3")
  const r = evaluateRuleB(rec, CFG)
  assert.equal(r.kind, "hit")
  assert.equal(r.evidence.sub, "dormant")
  assert.equal(r.evidence.turnsSince, 2)
})

test("rule B: no open todo items → null", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  recordTodowrite(rec, [{ id: "1", status: "completed" }])
  assert.equal(evaluateRuleB(rec, CFG), null)
  assert.equal(evaluateRuleB({ ...rec, lastTodo: null }, CFG), null)
})

// Regression: evaluateAllRules must forward cfg to rule B. Before the fix it
// called evaluateRuleB(rec) without cfg, so any session with open TODO items
// threw TypeError inside the transform hook (caught → whole rule evaluation
// including rule A silently skipped for that request).
test("regression: evaluateAllRules forwards cfg — B2 dormant fires through full path", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  recordTodowrite(rec, [{ id: "1", status: "in_progress" }])
  newRealUserTurn(rec, "u2")
  newRealUserTurn(rec, "u3")
  const results = evaluateAllRules(rec, CFG)
  const hit = results.find((r) => r.kind === "hit" && r.ruleId === "B.todo_stale")
  assert.ok(hit, "dormant hit must fire via evaluateAllRules with cfg forwarded")
  assert.equal(hit.evidence.sub, "dormant")
  assert.equal(hit.evidence.turnsSince, 2)
})

test("regression: evaluateAllRules forwards cfg — B1 completion-sync fires through full path", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  recordTodowrite(rec, [{ id: "1", status: "in_progress" }])
  recordTaskCompleted(rec, "task_delivery")
  recordAssistantDecision(rec, "a1")
  recordAssistantDecision(rec, "a2")
  const results = evaluateAllRules(rec, CFG)
  const hit = results.find((r) => r.kind === "hit" && r.ruleId === "B.todo_stale")
  assert.ok(hit, "completion-sync hit must fire via evaluateAllRules with cfg forwarded")
  assert.equal(hit.evidence.sub, "completion_sync")
  assert.equal(hit.evidence.decisionsSince, 2)
})

// ---------- candidates ----------

function withHit(rec, ruleId = "A.oracle_dispatch") {
  rec.currentEvidenceHash = evidenceHash(rec.currentUserText)
  return offerCandidate(rec, ruleId, { family: "irreversible_command" }, CFG)
}

test("candidates: same binding same rule dedupes", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "x"
  const first = withHit(rec)
  assert.equal(first.deduped, false)
  const second = withHit(rec)
  assert.equal(second.deduped, true)
  assert.equal(second.candidate.id, first.candidate.id)
  assert.equal(rec.candidates.length, 1)
})

test("candidates: new user input expires open candidates", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "x"
  const { candidate } = withHit(rec)
  assert.equal(candidate.status, "candidate")
  newRealUserTurn(rec, "u2")
  assert.equal(candidate.status, "expired")
  assert.equal(candidate.expiredReason, "new_user_input")
  // re-offer under new binding creates a NEW candidate
  const again = withHit(rec)
  assert.equal(again.deduped, false)
  assert.equal(again.candidate.binding.turnCount, 2)
})

test("candidates: injected same binding cannot be re-offered", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "x"
  const { candidate } = withHit(rec)
  markInjected(candidate)
  const again = withHit(rec)
  assert.equal(again.discard, "already_injected_same_binding")
})

test("candidates: binding invalid on evidence change or turn change", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "x"
  const { candidate } = withHit(rec)
  assert.equal(isBindingValid(candidate, rec), true)
  rec.currentEvidenceHash = evidenceHash("changed")
  assert.equal(isBindingValid(candidate, rec), false)
  newRealUserTurn(rec, "u2")
  assert.equal(isBindingValid(candidate, rec), false)
})

test("candidates: expireAll marks only open candidates", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "x"
  const a = withHit(rec).candidate
  expireAll(rec, "compacted")
  const b = withHit(rec).candidate // new open one after expiry? no—same binding, expired → discard
  // after expireAll the same binding offer is a discard
  const again = withHit(rec)
  assert.equal(a.status, "expired")
  assert.equal(again.discard, "expired_same_binding")
  assert.equal(b, undefined)
})

test("candidates: capped list", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "x"
  for (let i = 0; i < 30; i++) {
    rec.candidates.push({ id: `c${i}`, ruleId: "R", binding: { userTurnId: "u1", turnCount: 1, evidenceHash: "h" }, status: "expired" })
  }
  offerCandidate(rec, "A.oracle_dispatch", {}, CFG)
  assert.equal(rec.candidates.length, CFG.candidatesCap)
})

// ---------- nudge format ----------

test("nudge: format has prefix, binding summary, hint; respects length cap", () => {
  const rec = freshRecord("s1")
  newRealUserTurn(rec, "u1")
  rec.currentUserText = "x"
  const { candidate } = withHit(rec)
  const text = formatNudge(candidate, CFG.nudgeMaxChars)
  assert.ok(text.startsWith("[supervisor-nudge]"))
  assert.ok(text.includes(`rule=A.oracle_dispatch`))
  assert.ok(text.includes(`userTurn=u1`))
  assert.ok(text.includes(`turn=1`))
  assert.ok(text.length <= CFG.nudgeMaxChars)
  const short = formatNudge(candidate, 60)
  assert.ok(short.length <= 60)
  assert.ok(short.endsWith("…"))
})

test("nudge: injected message shape is append-only user text part", () => {
  const msg = buildInjectedMessage("[supervisor-nudge]\ntest", "sess1")
  assert.equal(msg.info.role, "user")
  assert.ok(msg.info.id.startsWith("msg_sn_"))
  assert.ok(!("sessionID" in msg.info), "info must match the verified probe shape (id + role only)")
  assert.equal(msg.parts.length, 1)
  assert.equal(msg.parts[0].type, "text")
  assert.ok(msg.parts[0].text.startsWith("[supervisor-nudge]"))
})

// ---------- integration: hooks (observe mode) ----------

test("observe mode: high-stakes turn → l0_hit logged, zero injection into messages", async () => {
  const { hooks, readLog } = await makePlugin({ mode: "observe" })
  const SID = "ses_obs"
  await sessionEvent(hooks, SID)
  await userTurnEvent(hooks, SID, "u1")
  await textPartEvent(hooks, SID, "u1", "please run git push -f origin main")
  await assistantEvent(hooks, SID, "a1")
  const messages = [
    { info: { id: "u1", role: "user", sessionID: SID }, parts: [{ type: "text", text: "please run git push -f origin main" }] },
    { info: { id: "a1", role: "assistant", sessionID: SID }, parts: [] },
  ]
  const snapshot = JSON.stringify(messages)
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  assert.equal(JSON.stringify(messages), snapshot, "observe mode must not touch messages")
  const log = readLog()
  const hit = log.find((e) => e.kind === "l0_hit")
  assert.ok(hit, "l0_hit expected in observe log")
  assert.equal(hit.ruleId, "A.oracle_dispatch")
  const evalEntry = log.find((e) => e.kind === "transform_eval")
  assert.equal(evalEntry.mode, "observe")
})

test("filter discard reasons counted: synthetic user text", async () => {
  const { hooks, readLog } = await makePlugin({})
  const SID = "ses_syn"
  await sessionEvent(hooks, SID)
  await userTurnEvent(hooks, SID, "u1")
  await textPartEvent(hooks, SID, "u1", "[blackboard] internal note")
  const log = readLog()
  const discard = log.find((e) => e.kind === "l0_discard" && e.reason === "synthetic_text")
  assert.ok(discard, "synthetic_text discard expected")
})

test("metadata-internal user message never becomes a turn", async () => {
  const { hooks, readLog } = await makePlugin({})
  const SID = "ses_meta"
  await sessionEvent(hooks, SID)
  await userTurnEvent(hooks, SID, "u1", { internalInitiator: "system" })
  await textPartEvent(hooks, SID, "u1", "run rm -rf /tmp/x")
  const log = readLog()
  assert.ok(log.find((e) => e.kind === "l0_discard" && e.reason === "metadata_internal"))
  assert.ok(!log.find((e) => e.kind === "user_turn"))
})

test("subagent session blacklisted; transform skips it", async () => {
  const { hooks, readLog } = await makePlugin({})
  const SID = "ses_kid"
  await hooks.event({
    event: { type: "subagent.session.created", properties: { sessionID: SID, info: { id: SID } } },
  })
  const messages = [{ info: { sessionID: SID, role: "user" }, parts: [] }]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  const log = readLog()
  assert.ok(log.find((e) => e.kind === "l0_discard" && e.reason === "blacklist_subagent_session"))
  assert.ok(log.find((e) => e.kind === "transform_skip" && e.reason === "blacklisted"))
})

test("unknown session in transform → skip, no ledger entry", async () => {
  const { hooks, readLog } = await makePlugin({})
  const messages = [{ info: { sessionID: "never-seen", role: "user" }, parts: [] }]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  assert.ok(readLog().find((e) => e.kind === "transform_skip" && e.reason === "no_ledger_entry"))
})

// ---------- integration: hooks (inject mode) ----------

async function injectSetup(hooks, SID) {
  await sessionEvent(hooks, SID)
  await userTurnEvent(hooks, SID, "u1")
  await textPartEvent(hooks, SID, "u1", "please run git push -f origin main now")
  await assistantEvent(hooks, SID, "a1")
}

test("inject mode: appends exactly one [supervisor-nudge] user message", async () => {
  const { hooks, readLog } = await makePlugin({ mode: "inject" })
  const SID = "ses_inj"
  await injectSetup(hooks, SID)
  const messages = [
    { info: { id: "u1", role: "user", sessionID: SID }, parts: [{ type: "text", text: "please run git push -f origin main now" }] },
    { info: { id: "a1", role: "assistant", sessionID: SID }, parts: [] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  assert.equal(messages.length, 3)
  const injected = messages[2]
  assert.equal(injected.info.role, "user")
  assert.ok(injected.parts[0].text.includes("[supervisor-nudge]"))
  assert.ok(injected.parts[0].text.includes(`turn=1`))
  const log = readLog()
  const inj = log.filter((e) => e.kind === "injected")
  assert.equal(inj.length, 1)
  assert.equal(inj[0].ruleId, "A.oracle_dispatch")
})

test("inject mode: same binding second request does not re-inject", async () => {
  const { hooks, readLog } = await makePlugin({ mode: "inject" })
  const SID = "ses_dedup"
  await injectSetup(hooks, SID)
  const messages = [
    { info: { id: "u1", role: "user", sessionID: SID }, parts: [] },
    { info: { id: "a1", role: "assistant", sessionID: SID }, parts: [] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  assert.equal(messages.length, 3)
  // second request for the SAME turn: retry-style resend, candidate already injected
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  assert.equal(messages.length, 3, "no second injection for same binding")
  assert.equal(readLog().filter((e) => e.kind === "injected").length, 1)
})

test("inject mode: per-session budget cap (default 3)", async () => {
  const { hooks, readLog } = await makePlugin({ mode: "inject" })
  const SID = "ses_budget"
  await sessionEvent(hooks, SID)
  const messages = []
  for (let turn = 1; turn <= 5; turn++) {
    await userTurnEvent(hooks, SID, `u${turn}`)
    await textPartEvent(hooks, SID, `u${turn}`, `run git push -f in step ${turn}`)
    await assistantEvent(hooks, SID, `a${turn}`)
    messages.push({ info: { id: `u${turn}`, role: "user", sessionID: SID }, parts: [] })
    await hooks["experimental.chat.messages.transform"]({}, { messages })
  }
  const injections = readLog().filter((e) => e.kind === "injected")
  assert.equal(injections.length, 3)
  assert.ok(readLog().find((e) => e.kind === "l0_discard" && e.reason === "inject_budget_exhausted"))
})

test("inject mode: unstable (compacted) → fail-safe skip", async () => {
  const { hooks, readLog } = await makePlugin({ mode: "inject" })
  const SID = "ses_cmp"
  await injectSetup(hooks, SID)
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: SID } } })
  const messages = [
    { info: { id: "u1", role: "user", sessionID: SID }, parts: [] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  assert.equal(messages.length, 1)
  assert.ok(readLog().find((e) => e.kind === "transform_skip" && e.reason === "unstable_compacted"))
})

test("transform never throws even on malformed input", async () => {
  const { hooks } = await makePlugin({})
  await assert.doesNotReject(hooks["experimental.chat.messages.transform"]({}, {}))
  await assert.doesNotReject(hooks["experimental.chat.messages.transform"]({}, { messages: "nope" }))
  await assert.doesNotReject(hooks.event({ event: { type: "message.updated" } }))
  await assert.doesNotReject(hooks.event({}))
})

test("log rotation: 5MB default and custom small cap rotates", async () => {
  const { hooks, logPath, dir } = await makePlugin({ logMaxBytes: 64 * 1024 })
  const SID = "ses_rot"
  await sessionEvent(hooks, SID)
  for (let i = 0; i < 800; i++) {
    await userTurnEvent(hooks, SID, `u${i}`)
  }
  assert.ok(fs.existsSync(path.join(dir, "log.jsonl.1")), "rotated file expected")
  const active = fs.statSync(logPath).size
  assert.ok(active <= 64 * 1024 + 4096, `active log should be near cap, got ${active}`)
})
