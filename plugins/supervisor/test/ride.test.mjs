// v6.2 system-ride delivery channel tests (design §III.8).
//
// Isolation mirrors test/tool.test.mjs / test/step1a.test.mjs: per-test
// mkdtemp fake host DB + store root; the production ~/.local/share/... roots
// are never touched (all paths injected). Approvals and delivery decisions
// are recorded through store.recordDecision — the exact calls the CLI makes.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { initStore, openStore } from "../lib/memory/store.mjs"
import {
  RIDE_BUDGET_CHARS,
  rideBodyHash,
  rideMarker,
  deriveDeliveryState,
  matchRideRules,
  createRideInjector,
} from "../lib/memory/ride.mjs"
import { printRideSentinel, runDeliveryEnable, runDeliveryDisable } from "../lib/memory/cli/delivery.mjs"
import { runApprove } from "../lib/memory/cli/approve.mjs"

// ---------- helpers ----------

const QUICK = { lockTimeoutMs: 200, lockPollMs: 5, pidGraceMs: 10 }
const PROJ_A = "proj_a"
const PROJ_B = "proj_b"
const RIDE_BODY = "Always answer with a one-line summary first."

function withTmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** Fake host opencode.db — session_v2 identity gate only. */
function createHostDb(t) {
  const dir = withTmp(t, "hostdbride-")
  const dbPath = path.join(dir, "opencode.db")
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, agent TEXT);")
  db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?)").run("ses_root_a", PROJ_A, null, "build")
  db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?)").run("ses_child_a", PROJ_A, "ses_root_a", "subagent")
  db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?)").run("ses_root_b", PROJ_B, null, "build")
  db.close()
  return dbPath
}

function makeRide(t) {
  const storeRoot = path.join(withTmp(t, "memride-"), "memory")
  initStore(storeRoot)
  const dbPath = createHostDb(t)
  const log = []
  const injector = createRideInjector({ cfg: { delivery: "inject", dbPath, storeRoot }, log: (e) => log.push(e) })
  const store = openStore(storeRoot, QUICK)
  return { storeRoot, dbPath, log, injector, store }
}

/** Approve a system-ride rule directly (the approval object runApprove records). */
function seedRideRule(store, { body = RIDE_BODY, scope = { kind: "project", projectId: PROJ_A }, agents = null, ts = Date.now() } = {}) {
  const object = {
    body,
    scope,
    targets: [], // system-ride: no static targets, ever
    reviewDate: "2026-11-22",
    channel: "system-ride",
    directoryBoundary: null,
    agents,
  }
  const { rule } = store.recordDecision({ kind: "approve", ruleId: null, object })
  // stamp deterministic approval order for the fixed-order test
  rule.createdAtTs = ts
  return rule
}

function deliveryEnable(store, rule, { version = rule.version, bodyHash = rideBodyHash(rule.body), channel = "system-ride" } = {}) {
  return store.recordDecision({ kind: "delivery-enable", ruleId: rule.id, object: { channel, version, bodyHash } })
}

function makeEvent({ sessionId = "ses_root_a", agent = "build", system } = {}) {
  return {
    sessionID: sessionId,
    agent,
    system: system ?? [
      { type: "text", text: "harness" },
      { type: "text", text: "model card" },
    ],
    messages: [],
  }
}

function rideLog(log, kind) {
  return log.filter((e) => e.kind === kind)
}

function expectRejected(entries, ruleId, stage) {
  const r = entries.find((e) => e.ruleId === ruleId)
  assert.ok(r, `expected an eval entry for ${ruleId}`)
  // injector eval entries carry outcome "rejected"; raw matcher entries only
  // carry the stage — both must expose the failing stage.
  if (r.outcome !== undefined) assert.equal(r.outcome, "rejected")
  assert.equal(r.stage, stage)
}

// ---------- gate: delivery state derivation ----------

test("deriveDeliveryState: latest decision wins; delivery-enable binds the quadruple", (t) => {
  const storeRoot = path.join(withTmp(t, "memds-"), "memory")
  initStore(storeRoot)
  const store = openStore(storeRoot, QUICK)
  const rule = seedRideRule(store)
  assert.equal(deriveDeliveryState(rule, store.listDecisions()).enabled, false, "approval alone does not deliver")
  deliveryEnable(store, rule)
  assert.equal(deriveDeliveryState(rule, store.listDecisions()).enabled, true)
  store.recordDecision({ kind: "delivery-disable", ruleId: rule.id })
  assert.equal(deriveDeliveryState(rule, store.listDecisions()).enabled, false, "disable after enable wins")
})

test("deriveDeliveryState: re-approve to a new version auto-resets delivery to disabled", (t) => {
  const storeRoot = path.join(withTmp(t, "memds2-"), "memory")
  initStore(storeRoot)
  const store = openStore(storeRoot, QUICK)
  const rule = seedRideRule(store)
  deliveryEnable(store, rule)
  assert.equal(deriveDeliveryState(rule, store.listDecisions()).enabled, true)
  // re-approve: same object body, existing ruleId → version bumps to 2
  store.recordDecision({ kind: "approve", ruleId: rule.id, object: { ...rule, targets: [], channel: "system-ride", agents: null, body: rule.body, scope: rule.scope, reviewDate: rule.reviewDate, directoryBoundary: null } })
  const v2 = store.getRule(rule.id)
  assert.equal(v2.version, 2)
  const st = deriveDeliveryState(v2, store.listDecisions())
  assert.equal(st.enabled, false, "old delivery-enable must not survive a re-approve")
  assert.match(st.reason, /auto-reset/)
})

test("store.recordDecision delivery-enable: version/bodyHash mismatches and wrong channel are refused inside the transaction", (t) => {
  const storeRoot = path.join(withTmp(t, "memds3-"), "memory")
  initStore(storeRoot)
  const store = openStore(storeRoot, QUICK)
  const rule = seedRideRule(store)
  assert.throws(() => deliveryEnable(store, rule, { version: 99 }), /binds version 99 but rule .* is v1/)
  assert.throws(() => deliveryEnable(store, rule, { bodyHash: "deadbeef" }), /bodyHash mismatch/)
  assert.throws(() => deliveryEnable(store, rule, { channel: "patch-human-apply" }), /must be "system-ride"/)
  assert.equal(store.listDecisions().filter((d) => d.kind === "delivery-enable").length, 0)
  // static-channel rule can never be delivery-enabled
  const staticObject = { body: RIDE_BODY, scope: { kind: "project", projectId: PROJ_A }, targets: [], reviewDate: "2026-11-22", channel: "patch-human-apply", directoryBoundary: null, agents: null }
  const { rule: staticRule } = store.recordDecision({ kind: "approve", ruleId: null, object: staticObject })
  assert.throws(() => deliveryEnable(store, staticRule), /system-ride delivery applies only/)
})

// ---------- gate negatives through the injector ----------

test("gate: approved but NOT delivery-enabled → rejected (stage delivery), system untouched", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store)
  const ev = makeEvent({})
  await r.injector.onContext(ev)
  assert.equal(ev.system.length, 2, "no element appended")
  expectRejected(rideLog(r.log, "memory_ride_eval")[0].rules, rule.id, "delivery")
})

test("gate: wrong channel (static rule) → rejected at stage channel (matcher defense-in-depth)", () => {
  // The store refuses delivery-enable on non-system-ride rules, so this
  // stage is unreachable through real records — it guards against a channel
  // typo in the log. Pure-matcher check with a hand-built rule.
  const staticRule = { id: "RUL-static", version: 1, status: "active", channel: "patch-human-apply", body: RIDE_BODY, scope: { kind: "project", projectId: PROJ_A }, agents: null, createdAtTs: 1 }
  const fakeDecisions = [{ kind: "delivery-enable", ruleId: "RUL-static", object: { channel: "system-ride", version: 1, bodyHash: rideBodyHash(RIDE_BODY) } }]
  const res = matchRideRules({ rules: [staticRule], decisions: fakeDecisions, projectId: PROJ_A, agent: "build" })
  assert.equal(res.picked.length, 0)
  expectRejected(res.rejected, "RUL-static", "channel")
})

test("gate: child session → refused at the session gate, nothing injected", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store)
  deliveryEnable(r.store, rule)
  const ev = makeEvent({ sessionId: "ses_child_a" })
  await r.injector.onContext(ev)
  assert.equal(ev.system.length, 2)
  const skip = rideLog(r.log, "memory_ride_skip")
  assert.ok(skip.length >= 1)
  assert.match(skip[0].reason, /child session/)
})

test("gate: cross-project session → rejected (stage project)", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store) // scoped proj_a
  deliveryEnable(r.store, rule)
  const ev = makeEvent({ sessionId: "ses_root_b" }) // proj_b
  await r.injector.onContext(ev)
  assert.equal(ev.system.length, 2)
  expectRejected(rideLog(r.log, "memory_ride_eval")[0].rules, rule.id, "project")
})

test("gate: wrong agent and unknown/missing agent → rejected / refused", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store, { agents: ["planner"] })
  deliveryEnable(r.store, rule)
  const evWrong = makeEvent({ agent: "build" })
  await r.injector.onContext(evWrong)
  expectRejected(rideLog(r.log, "memory_ride_eval")[0].rules, rule.id, "agent")
  const evMissing = makeEvent({ agent: null })
  await r.injector.onContext(evMissing)
  assert.equal(evMissing.system.length, 2)
  assert.ok(rideLog(r.log, "memory_ride_skip").some((e) => /unknown\/missing agent/.test(e.reason)))
})

test("gate: agent literal match delivers; empty agents = unrestricted", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store, { agents: ["build"] })
  deliveryEnable(r.store, rule)
  const ev = makeEvent({ agent: "build" })
  await r.injector.onContext(ev)
  assert.equal(ev.system.length, 3)
  assert.equal(ev.system[2].type, "text")
  assert.ok(ev.system[2].text.startsWith(`[supervisor-memory:rule:${rule.id}:v1]`))
  // unrestricted rule rides for any known agent
  const r2 = makeRide(t)
  const rule2 = seedRideRule(r2.store, { agents: null })
  deliveryEnable(r2.store, rule2)
  const ev2 = makeEvent({ agent: "any-agent-name" })
  await r2.injector.onContext(ev2)
  assert.equal(ev2.system.length, 3)
})

// ---------- injection mechanics ----------

test("budget: a whole item that does not fit is skipped (never truncated), fixed order kept", async (t) => {
  const r = makeRide(t)
  const small = seedRideRule(r.store, { body: "small rule", ts: 1000 })
  const big = seedRideRule(r.store, { body: "x".repeat(RIDE_BUDGET_CHARS + 50), ts: 2000 })
  deliveryEnable(r.store, small)
  deliveryEnable(r.store, big)
  const ev = makeEvent({})
  await r.injector.onContext(ev)
  assert.equal(ev.system.length, 3, "only the small rule rides")
  assert.ok(ev.system[2].text.includes("small rule"))
  const evalRules = rideLog(r.log, "memory_ride_eval")[0].rules
  const skipped = evalRules.find((e) => e.ruleId === big.id)
  assert.equal(skipped.outcome, "skipped:memory-cap-1200")
  assert.ok(!ev.system.some((el) => el.text.includes("x".repeat(60))), "big body never truncated into the prompt")
})

test("fixed order: two riding rules append in approval-time order", async (t) => {
  const r = makeRide(t)
  const first = seedRideRule(r.store, { body: "first body", ts: 1000 })
  const second = seedRideRule(r.store, { body: "second body", ts: 2000 })
  deliveryEnable(r.store, second) // enable in reverse order — order must still be approval time
  deliveryEnable(r.store, first)
  const ev = makeEvent({})
  await r.injector.onContext(ev)
  assert.equal(ev.system.length, 4)
  assert.ok(ev.system[2].text.includes("first body"))
  assert.ok(ev.system[3].text.includes("second body"))
})

test("marker idempotence: repeated hook invocation on the same system array never duplicates", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store)
  deliveryEnable(r.store, rule)
  const ev = makeEvent({})
  await r.injector.onContext(ev)
  await r.injector.onContext(ev) // same array object again
  assert.equal(ev.system.length, 3, "exactly one entry per rule")
  const evalRules = rideLog(r.log, "memory_ride_eval")[1].rules
  assert.equal(evalRules[0].dedup, true)
})

test("shape guard: non-conforming system → memory injection disabled only (latched); plugin log carries memory_shape_guard", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store)
  deliveryEnable(r.store, rule)
  const bad = { sessionID: "ses_root_a", agent: "build", system: { type: "text", text: "not an array" }, messages: [] }
  await r.injector.onContext(bad)
  const guard = rideLog(r.log, "memory_shape_guard")
  assert.equal(guard.length, 1)
  assert.match(guard[0].detail, /memory injection disabled only/)
  // latched: a later well-formed request still gets nothing from memory
  const good = makeEvent({})
  await r.injector.onContext(good)
  assert.equal(good.system.length, 2)
  assert.equal(rideLog(r.log, "memory_ride_eval").length, 0)
})

// ---------- modes ----------

test("shadow: full gate runs, would-ride logged with basis, system NEVER touched", async (t) => {
  const storeRoot = path.join(withTmp(t, "memshadow-"), "memory")
  initStore(storeRoot)
  const dbPath = createHostDb(t)
  const log = []
  const injector = createRideInjector({ cfg: { delivery: "shadow", dbPath, storeRoot }, log: (e) => log.push(e) })
  const store = openStore(storeRoot, QUICK)
  const rule = seedRideRule(store)
  deliveryEnable(store, rule)
  const ev = makeEvent({})
  const before = JSON.stringify(ev.system)
  await injector.onContext(ev)
  assert.equal(JSON.stringify(ev.system), before, "shadow never touches system")
  const evals = rideLog(log, "memory_ride_eval")
  assert.equal(evals.length, 1)
  assert.equal(evals[0].delivery, "shadow")
  assert.equal(evals[0].rules[0].outcome, "would-ride")
  assert.ok(evals[0].basis.picked.includes(`${rule.id}@v1`))
})

test("off: onContext is a no-op (default mode)", async (t) => {
  const storeRoot = path.join(withTmp(t, "memoff-"), "memory")
  initStore(storeRoot)
  const dbPath = createHostDb(t)
  const log = []
  const injector = createRideInjector({ cfg: { dbPath, storeRoot }, log: (e) => log.push(e) })
  assert.equal(injector.state.delivery, "off")
  const ev = makeEvent({})
  await injector.onContext(ev)
  assert.equal(ev.system.length, 2)
  assert.equal(log.length, 0)
})

test("matcher unit: directory scope can never ride; user-global rides across projects", () => {
  const dirRule = { id: "RUL-dir", version: 1, status: "active", channel: "system-ride", body: "b", scope: { kind: "directory", directory: "/x" }, agents: null, createdAtTs: 1 }
  const ugRule = { id: "RUL-ug", version: 1, status: "active", channel: "system-ride", body: "b", scope: { kind: "user-global" }, agents: null, createdAtTs: 2 }
  const enabled = [{ kind: "delivery-enable", ruleId: "RUL-dir", object: { channel: "system-ride", version: 1, bodyHash: rideBodyHash("b") } }, { kind: "delivery-enable", ruleId: "RUL-ug", object: { channel: "system-ride", version: 1, bodyHash: rideBodyHash("b") } }]
  const res = matchRideRules({ rules: [dirRule, ugRule], decisions: enabled, projectId: PROJ_B, agent: "build" })
  assert.deepEqual(res.picked.map((r) => r.id), ["RUL-ug"])
  expectRejected(res.rejected, "RUL-dir", "scope")
})

// ---------- CLI: delivery-enable / delivery-disable / approve channel ----------

function fakeIO(answers = [], { isTTY = true } = {}) {
  const prints = []
  let i = 0
  const take = (kind, prompt) => {
    const a = answers[i++]
    if (a === undefined) throw new Error(`fakeIO: answer #${i - 1} (${kind} "${prompt}") missing`)
    return a
  }
  return {
    isTTY,
    prints,
    calls: [],
    print: (...xs) => prints.push(xs.join(" ")),
    input: async (p) => take("input", p),
    inputLines: (p) => take("inputLines", p), // runApprove awaits a string body
    confirm: async (p) => (await take("confirm", p)) === "y",
    choose: async (p, options) => {
      const v = Number(take("choose", p))
      prints.push(`? ${p} → ${v}/${options.length}`)
      return v - 1
    },
  }
}

test("approve channel system-ride: no targets, no patches, decision carries the channel; agents bound", async (t) => {
  const r = makeRide(t)
  const iss = r.store.appendEvent({
    source: { sessionId: "ses_root_a", projectId: PROJ_A, messageId: "msg_ride" },
    evidence: { excerpt: "correction seed", messageRef: "msg_ride" },
    issueId: null,
    title: "ride candidate",
    topic: null,
  }).event.issueId
  const io = fakeIO([RIDE_BODY, "1", "2", "planner", "", "y", "y"]) // body → scope(1) → channel(2=system-ride) → agents → reviewDate → stage2? no: confirm×2
  const res = await runApprove({ store: r.store, io, cwd: "/nowhere", home: "/home/x" }, iss)
  assert.equal(res.code, 0)
  assert.equal(res.patches.length, 0)
  const rule = r.store.getRule(res.ruleId)
  assert.equal(rule.channel, "system-ride")
  assert.deepEqual(rule.targets, [])
  assert.deepEqual(rule.agents, ["planner"])
  assert.ok(io.prints.some((p) => /no patch to paste/.test(p)))
  assert.ok(io.prints.some((p) => /delivery-enable/.test(p)))
  assert.ok(!io.prints.some((p) => p.includes("supervisor-memory:rule:")), "system-ride approval never prints an AGENTS.md patch")
})

test("CLI delivery-enable TTY: records the binding; duplicate enable records nothing; disable stops it", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store)
  // stage1 confirm → stage2 confirm
  const io = fakeIO(["y", "y"])
  const code = await runDeliveryEnable({ store: r.store, io }, rule.id)
  assert.equal(code, 0)
  const decs = r.store.listDecisions().filter((d) => d.kind === "delivery-enable")
  assert.equal(decs.length, 1)
  assert.equal(decs[0].object.version, 1)
  assert.equal(decs[0].object.bodyHash, rideBodyHash(rule.body))
  assert.equal(decs[0].object.channel, "system-ride")
  assert.ok(io.prints.some((p) => p.includes("will be injected into the system prompt of every model request of matching sessions")))
  // duplicate: already enabled → nothing recorded, exit 0
  const io2 = fakeIO([])
  const code2 = await runDeliveryEnable({ store: r.store, io: io2 }, rule.id)
  assert.equal(code2, 0)
  assert.equal(r.store.listDecisions().filter((d) => d.kind === "delivery-enable").length, 1)
  // disable
  const io3 = fakeIO(["y"])
  const code3 = await runDeliveryDisable({ store: r.store, io: io3 }, rule.id)
  assert.equal(code3, 0)
  const dis = r.store.listDecisions().filter((d) => d.kind === "delivery-disable")
  assert.equal(dis.length, 1)
  assert.ok(io3.prints.some((p) => /only stops appending/.test(p)))
  assert.equal(deriveDeliveryState(r.store.getRule(rule.id), r.store.listDecisions()).enabled, false)
  // disabled rule no longer rides
  const ev = makeEvent({})
  await r.injector.onContext(ev)
  assert.equal(ev.system.length, 2)
})

// ---------- digest sentinel ----------

test("digest sentinel: enabled rules show recent eligible sessions, rides and agent distribution; no data → unknown", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store)
  deliveryEnable(r.store, rule)
  const logPath = path.join(withTmp(t, "ridelog-"), "log.jsonl")
  const evalEntry = (sessionId, agent, outcome) => JSON.stringify({ kind: "memory_ride_eval", sessionId, agent, rules: [{ ruleId: rule.id, outcome }] })
  fs.writeFileSync(logPath, [evalEntry("s1", "build", "rode"), evalEntry("s2", "build", "skipped:memory-cap-1200"), evalEntry("s3", "planner", "rejected")].join("\n"))
  const lines = []
  const orig = console.log
  console.log = (...xs) => lines.push(xs.join(" "))
  try {
    printRideSentinel(r.store, { logPath })
    printRideSentinel(r.store, { logPath: path.join(withTmp(t, "ridelog-empty-"), "missing.jsonl") })
  } finally {
    console.log = orig
  }
  assert.ok(lines.some((l) => l.includes("system-ride sentinel")))
  assert.ok(lines.some((l) => /RUL-[\w-]+ v1 — recent 2 eligible sessions, 1 rides, agents seen: build/.test(l)), lines.join("\n"))
  assert.ok(lines.some((l) => /no session data in the plugin log window \(unknown\)/.test(l)))
})

test("digest sentinel: no enabled runtime rules → prints nothing", async (t) => {
  const r = makeRide(t)
  seedRideRule(r.store) // approved but not delivery-enabled
  const lines = []
  const orig = console.log
  console.log = (...xs) => lines.push(xs.join(" "))
  try {
    printRideSentinel(r.store, { logPath: "/nonexistent/log.jsonl" })
  } finally {
    console.log = orig
  }
  assert.equal(lines.length, 0)
})

// ---------- end-to-end: inject → withdraw → re-bind ----------

test("end-to-end: enable → rides → disable → stops → re-enable re-binds → rides again", async (t) => {
  const r = makeRide(t)
  const rule = seedRideRule(r.store)
  deliveryEnable(r.store, rule)
  const ev = makeEvent({})
  await r.injector.onContext(ev)
  assert.equal(ev.system.length, 3)
  r.store.recordDecision({ kind: "delivery-disable", ruleId: rule.id })
  const ev2 = makeEvent({})
  await r.injector.onContext(ev2)
  assert.equal(ev2.system.length, 2, "stop appending on the next evaluation")
  // re-bind the SAME version (disable then enable again)
  deliveryEnable(r.store, rule)
  const ev3 = makeEvent({})
  await r.injector.onContext(ev3)
  assert.equal(ev3.system.length, 3)
  assert.ok(ev3.system[2].text.startsWith(rideMarker(rule)))
})
