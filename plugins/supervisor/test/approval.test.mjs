// R33+ adjudication suite for phase 3: Bridge A confirmation tooling, the
// shared approval service layer (TOCTOU fix), and the stop-class tools.
//
// Bridge A is exercised against a LOCAL HTTP MOCK that reproduces the host
// form lifecycle (create → pending → reply/cancel/delete), informed by the
// probe (/tmp/opencode/q-bridge). The deadline contract is enforced with an
// injectable clock (cfg.confirm.now), so the late-answer race is tested
// deterministically.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"

import { initStore, openStore } from "../lib/memory/store.mjs"
import { deriveDeliveryState, RIDE_CHANNEL } from "../lib/memory/ride.mjs"
import {
  executeApproveRule,
  executeEnableDelivery,
  executeDisableDelivery,
  executeDisableRule,
} from "../lib/memory/approval-tools.mjs"
import { submitDecision, withApprovalLock, snapshotState } from "../lib/memory/approval-service.mjs"
import { createConfirmBridge, CONFIRM_VALUE, CANCEL_VALUE, clampConfirmTimeoutMin } from "../lib/memory/confirm.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- fixtures ----------

const PROJ_A = "proj-a"
const BODY = "在 JavaScript 中始终使用 const 声明变量\n不要使用 var"

function seedIssue(storeRoot, { projectId = PROJ_A } = {}) {
  const store = openStore(storeRoot)
  const r = store.appendEvent({
    source: { sessionId: "ses-" + Math.random().toString(16).slice(2), projectId, messageId: "msg-" + Math.random().toString(16).slice(2) },
    evidence: { excerpt: "始终用 const, 不要用 var" },
    title: "JS 变量声明规则",
    topic: "code-style",
    classification: { kind: "preference", layer: "project" },
  })
  return r.issue
}

/** Seed an approved rule directly through the store (bypasses confirmation —
 *  the confirmation flow itself is what the other tests exercise). */
function seedRule(storeRoot, { body = BODY, channel = RIDE_CHANNEL, targets = [], agents = null } = {}) {
  const store = openStore(storeRoot)
  const object = {
    body,
    scope: { kind: "project", projectId: PROJ_A },
    targets,
    reviewDate: "2027-01-01",
    channel,
    directoryBoundary: null,
    agents,
  }
  const { decision, rule } = store.recordDecision({ kind: "approve", ruleId: null, object })
  return { decision, rule }
}

/** Local Bridge A mock: the host form HTTP lifecycle over 127.0.0.1. */
function makeFormHost(t, { failDelete = false } = {}) {
  const forms = new Map()
  let counter = 0
  let sawAuth = false
  const EXPECT_AUTH = "Basic " + Buffer.from("opencode:test-pw").toString("base64")
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== EXPECT_AUTH) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { _tag: "UnauthorizedError" } }))
      return
    }
    sawAuth = true
    const parts = req.url.split("?")[0].split("/").filter(Boolean) // api session {sid} form {fid} {verb?}
    const sid = parts[2]
    const fid = parts[4]
    const verb = parts[5] // "reply"
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      let bodyJson = null
      try {
        bodyJson = raw ? JSON.parse(raw) : null
      } catch {
        bodyJson = null
      }
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" })
        res.end(JSON.stringify(obj ?? {}))
      }
      if (req.method === "POST" && parts[3] === "form" && fid === undefined) {
        if (!bodyJson?.title || !Array.isArray(bodyJson?.fields)) {
          send(400, { error: { _tag: "FormInvalidPayloadError" } })
          return
        }
        const id = `frm_${String(++counter).padStart(4, "0")}`
        forms.set(id, { id, sessionID: sid, title: bodyJson.title, fields: bodyJson.fields, metadata: bodyJson.metadata ?? {}, state: { status: "pending" } })
        send(200, { id })
        return
      }
      const f = forms.get(fid)
      if (!f) {
        send(404, { error: { _tag: "FormNotFoundError" } })
        return
      }
      if (req.method === "GET") {
        send(200, { id: f.id, sessionID: f.sessionID, title: f.title, fields: f.fields, state: f.state })
        return
      }
      if (req.method === "DELETE") {
        if (failDelete) {
          send(500, { error: { _tag: "FormDeleteFailedError" } })
          return
        }
        forms.delete(fid)
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === "POST" && verb === "reply") {
        if (f.state.status !== "pending") {
          send(409, { error: { _tag: "FormAlreadySettledError" } })
          return
        }
        if (!bodyJson || typeof bodyJson !== "object" || typeof bodyJson.answer?.choice !== "string") {
          send(400, { error: { _tag: "FormInvalidAnswerError" } })
          return
        }
        f.state = { status: "answered", answer: bodyJson.answer }
        send(200, { id: f.id, state: f.state })
        return
      }
      send(404, { error: { _tag: "FormNotFoundError" } })
    })
  })
  const ready = new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
  t.after(() => new Promise((r) => server.close(r)))
  /** Test driver: reply/cancel/remove a form directly. */
  return {
    forms,
    server,
    ready,
    sawAuth: () => sawAuth,
    pendingCount: () => [...forms.values()].filter((f) => f.state.status === "pending").length,
    ids: () => [...forms.keys()],
    pendingIds: () => [...forms.values()].filter((f) => f.state.status === "pending").map((f) => f.id),
    get: (fid) => forms.get(fid),
    reply: (fid, answer) => {
      const f = forms.get(fid)
      if (f && f.state.status === "pending") f.state = { status: "answered", answer }
    },
    cancel: (fid) => {
      const f = forms.get(fid)
      if (f && f.state.status === "pending") f.state = { status: "cancelled", message: "cancelled by test" }
    },
    remove: (fid) => forms.delete(fid), // simulates host-side form loss (fork/cleanup)
    displayOf: (fid) => forms.get(fid)?.fields?.[0]?.description ?? "",
  }
}

/** Full env: store + fake host db + Bridge A mock + service.json discovery. */
async function makeEnv(t, { failDelete = false, bridgeClock = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "svmem-approval-"))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const proj = path.join(base, "proj")
  fs.mkdirSync(proj, { recursive: true })
  const storeRoot = path.join(base, "store")
  initStore(storeRoot)
  const target = path.join(proj, "AGENTS.md")
  fs.writeFileSync(target, "# Project notes\n")
  const dbPath = path.join(base, "host.db")
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, agent TEXT);")
  const ins = db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?)")
  ins.run("ses_root_a", PROJ_A, null, "build")
  ins.run("ses_child_a", PROJ_A, "ses_root_a", "subagent")
  ins.run("ses_root_b", "proj-b", null, "build")
  db.close()

  const formHost = makeFormHost(t, { failDelete })
  const port = await formHost.ready
  const svcPath = path.join(base, "service.json")
  fs.writeFileSync(
    svcPath,
    JSON.stringify({ id: "opencode", version: "2.1.4", url: `http://127.0.0.1:${port}`, pid: process.pid, password: "test-pw" }),
  )
  const clock = { offsetMs: 0 }
  const cfg = {
    enable: true,
    mock: false,
    dbPath,
    storeRoot,
    mockDir: null,
    confirmTimeoutMin: 1,
    confirm: {
      env: { OPENCODE_SERVICE_JSON: svcPath },
      readFile: fs.promises.readFile,
      fetchImpl: globalThis.fetch,
      pollMs: 5,
      httpTimeoutMs: 2000,
      ...(bridgeClock ? { now: () => Date.now() + clock.offsetMs } : {}),
    },
  }
  return { base, proj, storeRoot, target, cfg, formHost, clock, svcPath }
}

const CTX_A = { sessionID: "ses_root_a" }

function auditLines(storeRoot) {
  const p = path.join(storeRoot, "approval-audit.jsonl")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Wait until the mock has ≥1 PENDING form (forms answered/cancelled earlier
 *  in the same env are skipped), then return the newest pending id. */
async function waitForForm(formHost) {
  for (let i = 0; i < 5000; i++) {
    const pend = formHost.pendingIds()
    if (pend.length > 0) return pend.at(-1)
    await sleep(2)
  }
  throw new Error("no form ever created")
}

function decisionsCount(storeRoot) {
  return openStore(storeRoot).listDecisions().length
}

/** Rebuild the exact approval object a rule was approved with (for a
 *  same-shape re-approval by a "concurrent actor"). */
function approvalObjectOf(rule) {
  return {
    body: rule.body,
    scope: rule.scope,
    targets: rule.targets,
    reviewDate: rule.reviewDate ?? null,
    channel: rule.channel ?? null,
    directoryBoundary: rule.directoryBoundary ?? null,
    agents: rule.agents ?? null,
  }
}

// ---------- Bridge A adapter (unit) ----------

test("clampConfirmTimeoutMin: default 10, cap 30, floor 1, junk → default", () => {
  assert.equal(clampConfirmTimeoutMin(undefined), 10)
  assert.equal(clampConfirmTimeoutMin(30), 30)
  assert.equal(clampConfirmTimeoutMin(31), 30)
  assert.equal(clampConfirmTimeoutMin(0.5), 1)
  assert.equal(clampConfirmTimeoutMin("7"), 7)
  assert.equal(clampConfirmTimeoutMin("bogus"), 10)
})

test("bridge unit: single-choice field (custom:false), Basic auth, consume-once replay refused", async (t) => {
  const formHost = makeFormHost(t)
  const port = await formHost.ready
  const bridge = createConfirmBridge({
    base: `http://127.0.0.1:${port}`,
    authHeader: "Basic " + Buffer.from("opencode:test-pw").toString("base64"),
    pollMs: 5,
    httpTimeoutMs: 2000,
  })
  const display = "FULL OBJECT DISPLAY\n  | line two"
  const { formID } = await bridge.createForm({ sessionID: "ses_x", title: "Approve?", display, objectHash: "oh-123", kind: "memory_approve_rule" })
  assert.match(formID, /^frm_/)
  assert.equal(formHost.sawAuth(), true)
  const f = formHost.get(formID)
  assert.equal(f.fields.length, 1)
  assert.equal(f.fields[0].key, "choice")
  assert.equal(f.fields[0].custom, false, "no free text may exist")
  assert.deepEqual(
    f.fields[0].options.map((o) => o.value),
    [CONFIRM_VALUE, CANCEL_VALUE],
  )
  assert.equal(f.fields[0].description, display, "the display travels verbatim")
  assert.equal(f.metadata.kind, "memory_approve_rule")
  assert.equal(f.metadata.objectHash, "oh-123")

  bridge.consume(formID) // first consumption ok
  assert.throws(() => bridge.consume(formID), (e) => e.code === "MEMORY_CONFIRMATION_REPLAY")
})

test("bridge unit: waitAnswer deadline precedes read AND answered-acceptance; expiry DELETEs the form", async (t) => {
  const formHost = makeFormHost(t)
  const port = await formHost.ready
  let fakeNow = Date.now()
  const bridge = createConfirmBridge({
    base: `http://127.0.0.1:${port}`,
    authHeader: "Basic " + Buffer.from("opencode:test-pw").toString("base64"),
    pollMs: 5,
    httpTimeoutMs: 2000,
    now: () => fakeNow,
  })
  const { formID } = await bridge.createForm({ sessionID: "s", title: "t", display: "d", objectHash: "h" })

  // (a) expired BEFORE any read: no decision could even be asked for
  fakeNow += 10 * 60_000
  const r1 = await bridge.waitAnswer({ sessionID: "s", formID, deadlineTs: fakeNow - 1 })
  assert.equal(r1.status, "expired")
  assert.equal(r1.cleanup, "form-deleted")
  assert.equal(formHost.get(formID), undefined, "expired form is DELETEd")

  // (b) late-answer race: answer arrives, THEN the deadline passes — the
  // answered state must never be consumed (probe bug at qbridge/index.mjs:107-114).
  const { formID: fid2 } = await bridge.createForm({ sessionID: "s", title: "t", display: "d", objectHash: "h" })
  formHost.reply(fid2, { choice: CONFIRM_VALUE })
  fakeNow += 10 * 60_000
  const r2 = await bridge.waitAnswer({ sessionID: "s", formID: fid2, deadlineTs: fakeNow - 1 })
  assert.equal(r2.status, "expired", "answered-but-expired → expired, never answered")
  assert.equal(formHost.get(fid2), undefined)

  // (c) DELETE failure still refuses the late answer (cleanup is reported)
  const formHost2 = makeFormHost(t, { failDelete: true })
  const port2 = await formHost2.ready
  const bridge2 = createConfirmBridge({
    base: `http://127.0.0.1:${port2}`,
    authHeader: "Basic " + Buffer.from("opencode:test-pw").toString("base64"),
    pollMs: 5,
    httpTimeoutMs: 2000,
    now: () => fakeNow,
  })
  const { formID: fid3 } = await bridge2.createForm({ sessionID: "s", title: "t", display: "d", objectHash: "h" })
  formHost2.reply(fid3, { choice: CONFIRM_VALUE })
  fakeNow += 10 * 60_000
  const r3 = await bridge2.waitAnswer({ sessionID: "s", formID: fid3, deadlineTs: fakeNow - 1 })
  assert.equal(r3.status, "expired", "delete failure must not turn into an accepted answer")
  assert.match(r3.cleanup, /^form-delete-failed/)
})

// ---------- tool guard rails ----------

async function forgedCase(t, env, extra) {
  const issue = seedIssue(env.storeRoot)
  const res = await executeApproveRule(
    { issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride", ...extra },
    CTX_A,
    { cfg: env.cfg },
  )
  return res
}

test("forged confirmation arguments are rejected before any form exists (R33 §②)", async (t) => {
  const env = await makeEnv(t)
  for (const key of ["confirmed", "confirm", "approved", "answer", "userAgreed", "user_agreed", "hash", "objectHash", "decisionId", "formId"]) {
    const res = await forgedCase(t, env, { [key]: "anything-the-model-might-invent" })
    assert.equal(res.ok, false, key)
    assert.equal(res.code, "MEMORY_INVALID_INPUT", key)
    assert.match(res.message, /never/, key)
  }
  assert.equal(env.formHost.ids().length, 0, "no form may be created on forged input")
  assert.equal(await decisionsCount(env.storeRoot), 0)
})

test("gate + scope guards: subagent rejected, cross-project issue rejected, arg-shape errors", async (t) => {
  const env = await makeEnv(t)
  // subagent session
  const issue = seedIssue(env.storeRoot)
  const sub = await executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, { sessionID: "ses_child_a" }, { cfg: env.cfg })
  assert.equal(sub.code, "MEMORY_SESSION_REJECTED")
  // foreign issue (belongs to proj-b)
  const foreign = seedIssue(env.storeRoot, { projectId: "proj-b" })
  const res2 = await executeApproveRule({ issueId: foreign.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  assert.equal(res2.code, "MEMORY_ISSUE_FOREIGN")
  // both ids / neither id
  assert.equal((await executeApproveRule({ issueId: issue.id, ruleId: "RUL-x", body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })).code, "MEMORY_INVALID_INPUT")
  assert.equal((await executeApproveRule({ body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })).code, "MEMORY_INVALID_INPUT")
  // body over 10 lines
  const long = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join("\n")
  assert.equal((await executeApproveRule({ issueId: issue.id, body: long, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })).code, "MEMORY_INVALID_INPUT")
  // channel+scope mismatches
  assert.equal((await executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "directory", directory: env.proj }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })).code, "MEMORY_SCOPE_RIDE_MISMATCH")
  assert.equal((await executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "patch-human-apply", targets: [] }, CTX_A, { cfg: env.cfg })).code, "MEMORY_INVALID_INPUT")
  assert.equal((await executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "patch-human-apply", targets: ["relative/path"] }, CTX_A, { cfg: env.cfg })).code, "MEMORY_TARGET_INVALID")
  assert.equal((await executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "patch-human-apply", targets: [path.join(env.proj, "nope.md")] }, CTX_A, { cfg: env.cfg })).code, "MEMORY_TARGET_INVALID")
  assert.equal(
    (await executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "patch-human-apply", targets: [env.target], agents: ["build"] }, CTX_A, { cfg: env.cfg })).code,
    "MEMORY_AGENTS_SCOPE_UNHONORABLE",
  )
  assert.equal(await decisionsCount(env.storeRoot), 0)
  assert.equal(env.formHost.ids().length, 0, "refusals never reach the user with a form")
})

// ---------- approval happy path + display ----------

test("approve tool (system-ride): full display binds the object, confirm records exactly one decision, issue approved, delivery NOT enabled, files untouched", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const beforeBytes = fs.readFileSync(env.target)
  const p = executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  const disp = env.formHost.displayOf(formID)
  assert.ok(disp.includes(BODY.split("\n")[0]), "full body line 1 shown")
  assert.ok(disp.includes(BODY.split("\n")[1]), "full body line 2 shown")
  assert.ok(/project proj-a/.test(disp))
  assert.ok(/PERSISTENT system-prompt delivery across sessions, not just this session/.test(disp), "system-ride persistence must be explicit")
  assert.ok(/does NOT enable delivery/.test(disp))
  assert.ok(/revocation boundary/.test(disp))
  assert.ok(/deadline: unanswered requests expire at /.test(disp))
  assert.ok(/object hash \(confirmation binding\): [0-9a-f]{64}/.test(disp))
  env.formHost.reply(formID, { choice: "confirm" })
  const res = await p
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(res.decisionId, /^DEC/)
  assert.match(res.ruleId, /^RUL-/)
  assert.equal(res.version, 1)
  assert.match(res.formID, /^frm_/)
  assert.equal(typeof res.snapshotHash, "string")

  const store = openStore(env.storeRoot)
  const rule = store.getRule(res.ruleId)
  assert.equal(rule.version, 1)
  assert.equal(rule.status, "active")
  assert.equal(rule.channel, RIDE_CHANNEL)
  const decisions = store.listDecisions()
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, "approve")
  assert.equal(store.getIssue(issue.id).status, "approved")
  assert.equal(deriveDeliveryState(rule, decisions).enabled, false, "approve ≠ delivery")
  assert.deepEqual(fs.readFileSync(env.target), beforeBytes, "approval writes nothing")
  const audit = auditLines(env.storeRoot)
  assert.equal(audit.at(-1).outcome, "recorded")
  assert.equal(audit.at(-1).decisionId, res.decisionId)
  assert.equal(audit.at(-1).formID, formID)
  assert.equal(audit.at(-1).sessionID, "ses_root_a")
  assert.equal(typeof audit.at(-1).deadlineTs, "number")
})

test("approve tool (patch-human-apply): receipt notes manual-apply path, no delivery vocabulary, file untouched", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const beforeBytes = fs.readFileSync(env.target)
  const p = executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "patch-human-apply", targets: [env.target] }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  env.formHost.reply(formID, { choice: "confirm" })
  const res = await p
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(res.targets, [env.target])
  assert.match(res.note, /memory_prepare_publish/)
  assert.match(res.note, /approval ≠ applied|M ANUALLY|MANUAL/)
  assert.deepEqual(fs.readFileSync(env.target), beforeBytes)
})

// ---------- cancel / disconnect / unavailable / stale ----------

test("Cancel → MEMORY_CONFIRMATION_CANCELLED, nothing recorded, audit outcome cancelled", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const p = executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  env.formHost.reply(formID, { choice: "cancel" })
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_CONFIRMATION_CANCELLED")
  assert.equal(await decisionsCount(env.storeRoot), 0)
  assert.equal(auditLines(env.storeRoot).at(-1).outcome, "cancelled")
})

test("host form loss (fork/cleanup) mid-wait → MEMORY_CONFIRMATION_STALE, nothing recorded", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const p = executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  env.formHost.remove(formID) // fork/teardown made the binding disappear
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_CONFIRMATION_STALE")
  assert.equal(await decisionsCount(env.storeRoot), 0)
  assert.equal(auditLines(env.storeRoot).at(-1).outcome, "stale")
})

test("deadline expiry (tool level): expired envelope with cleanup, no decision, form deleted", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  env.clock.offsetMs = 61 * 60_000 // deadline was 1 min out; clock jumps past it
  const res = await executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_CONFIRMATION_EXPIRED")
  assert.match(res.message, /expired unanswered after 1 minutes/)
  assert.ok(res.message.includes("form-deleted"), "cleanup reported: " + res.message)
  assert.equal(await decisionsCount(env.storeRoot), 0)
  assert.equal(env.formHost.ids().length, 0, "pending form deleted on expiry")
  assert.equal(auditLines(env.storeRoot).at(-1).outcome, "expired")
})

test("late-answer race (tool level): user confirms AFTER the deadline → expired, never consumed, no decision", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const p = executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  env.formHost.reply(formID, { choice: "confirm" }) // user answers just inside…
  env.clock.offsetMs = 61 * 60_000 // …but the deadline has passed by poll time
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_CONFIRMATION_EXPIRED")
  assert.equal(await decisionsCount(env.storeRoot), 0, "the late confirm must record NOTHING")
  assert.equal(auditLines(env.storeRoot).at(-1).outcome, "expired")
})

test("bridge unreachable → MEMORY_CONFIRMATION_UNAVAILABLE with CLI fallback, nothing recorded", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const cfg = {
    ...env.cfg,
    confirm: {
      env: {},
      readFile: () => {
        const e = new Error("no service.json")
        e.code = "ENOENT"
        throw e
      },
    },
  }
  const res = await executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg })
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_CONFIRMATION_UNAVAILABLE")
  assert.match(res.message, /CLI approve/)
  assert.equal(await decisionsCount(env.storeRoot), 0)
  assert.equal(env.formHost.ids().length, 0, "the mock host must not have been used")
})

// ---------- snapshot staleness (TOCTOU, form-side) ----------

test("issue status changed while the form was open → submit refuses: MEMORY_CONFIRMATION_STALE, nothing recorded", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const p = executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  openStore(env.storeRoot).upsertIssue({ id: issue.id, status: "approved" }) // store moved AFTER display
  env.formHost.reply(formID, { choice: "confirm" })
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_CONFIRMATION_STALE")
  assert.match(res.message, /brand-new decision/)
  assert.equal(await decisionsCount(env.storeRoot), 0, "the late confirm must record NOTHING")
  assert.equal(auditLines(env.storeRoot).at(-1).outcome, "stale")
})

test("rule re-approved by another actor while the v2-approval form was open → stale, no second version", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  const p = executeApproveRule({ ruleId: rule.id, body: BODY + "\n(v2 line)", scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  openStore(env.storeRoot).recordDecision({ kind: "approve", ruleId: rule.id, object: approvalObjectOf(rule) }) // concurrent actor wins
  env.formHost.reply(formID, { choice: "confirm" })
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_CONFIRMATION_STALE")
  assert.equal(openStore(env.storeRoot).getRule(rule.id).version, 2, "only the other actor's version exists")
})

test("rule disabled while the approval form was open → stale", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  const p = executeApproveRule({ ruleId: rule.id, body: BODY + "\n(v2)", scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  openStore(env.storeRoot).recordDecision({ kind: "disable", ruleId: rule.id })
  env.formHost.reply(formID, { choice: "confirm" })
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_CONFIRMATION_STALE")
  assert.equal(openStore(env.storeRoot).getRule(rule.id).status, "disabled")
})

// ---------- critical section (cross-process) ----------

/** Child process that WAITS for the approval lock (unless held), then holds
 *  it for `ms`, signaling acquisition by touching `ready`. */
const SERVICE_URL = "file://" + pathToFileURL(new URL("../lib/memory/approval-service.mjs", import.meta.url))

function writeLockChild(t, dir) {
  const p = path.join(dir, "lock-child.mjs")
  fs.writeFileSync(
    p,
    `import fs from "node:fs"
import { withApprovalLock } from ${JSON.stringify(SERVICE_URL)}
const [root, ms, ready] = process.argv.slice(2)
try {
  await withApprovalLock(root, () => {
    fs.writeFileSync(ready, String(process.pid))
    const b = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(b), 0, 0, Number(ms))
  }, { lockTimeoutMs: 5000, pollMs: 10 })
  console.log("CHILD_OK")
} catch (e) {
  console.log("CHILD_ERR:" + (e.code ?? e.name))
  process.exit(1)
}
`,
  )
  return p
}

function pathToFileURL(u) {
  return u.pathname
}

/** Spawn the holder child and wait until it signals lock ownership. */
async function startHolder(child, env, ms) {
  const ready = path.join(env.base, "ready-" + Math.random().toString(16).slice(2))
  const c = spawn(process.execPath, [child, env.storeRoot, String(ms), ready], { stdio: "ignore" })
  c.unref()
  for (let i = 0; i < 5000 && !fs.existsSync(ready); i++) await sleep(2)
  if (!fs.existsSync(ready)) throw new Error("lock child never acquired the section")
  return c
}

test("cross-process mutex: a second caller gets MEMORY_APPROVAL_BUSY while the section is held", async (t) => {
  const env = await makeEnv(t)
  const child = writeLockChild(t, env.base)
  const c = await startHolder(child, env, 800)
  let err = null
  try {
    withApprovalLock(env.storeRoot, () => {}, { lockTimeoutMs: 200, pollMs: 10 })
  } catch (e) {
    err = e
  }
  assert.ok(err, "withApprovalLock must refuse while another process holds the section")
  assert.equal(err.code, "MEMORY_APPROVAL_BUSY")
  await sleep(900) // let the child release before the fixture dir is removed
  c.kill()
})

test("cross-process serialization: submitDecision WAITS for a busy section and then records exactly once", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  const child = writeLockChild(t, env.base)
  const c = await startHolder(child, env, 400)
  const snapshot = snapshotState(openStore(env.storeRoot), { ruleId: rule.id })
  const t0 = Date.now()
  const { decision } = submitDecision({ store: openStore(env.storeRoot), kind: "delivery-disable", ruleId: rule.id, snapshot })
  assert.ok(Date.now() - t0 >= 200, "submitDecision must wait for the busy section, not fail")
  assert.match(decision.id, /^DEC/)
  assert.equal(openStore(env.storeRoot).listDecisions().filter((d) => d.kind === "delivery-disable").length, 1)
  await sleep(400)
  c.kill()
})

test("exactly-once under concurrent submissions with the same display snapshot (single version bump)", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const store = openStore(env.storeRoot)
  const snap = {
    decisionsTotal: store.listDecisions().length,
    rule: null,
    issue: { status: store.getIssue(issue.id).status, updatedAtTs: store.getIssue(issue.id).updatedAtTs },
  }
  const object = {
    body: BODY,
    scope: { kind: "project", projectId: PROJ_A },
    targets: [],
    reviewDate: "2027-01-01",
    channel: RIDE_CHANNEL,
    directoryBoundary: null,
    agents: null,
  }
  const results = await Promise.allSettled([
    Promise.resolve().then(() => submitDecision({ store, kind: "approve", ruleId: null, issueId: issue.id, object, snapshot: snap })),
    Promise.resolve().then(() => submitDecision({ store, kind: "approve", ruleId: null, issueId: issue.id, object, snapshot: snap })),
  ])
  const fulfilled = results.filter((r) => r.status === "fulfilled")
  const rejected = results.filter((r) => r.status === "rejected")
  assert.equal(fulfilled.length, 1, "exactly one submission may win")
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, "MEMORY_CONFIRMATION_STALE")
  assert.equal(store.listDecisions().length, 1)
  const newRuleId = fulfilled[0].value.rule.id
  assert.equal(store.getRule(newRuleId).version, 1, "a single version bump")
})

// ---------- post-submit failure carries the decisionId ----------

test("post-submit failure: issue status update fails → receipt carries decisionId + do-not-retry warning, no duplicate decision", async (t) => {
  const env = await makeEnv(t)
  const issue = seedIssue(env.storeRoot)
  const cfg = {
    ...env.cfg,
    testHooks: {
      upsertIssue: () => {
        throw new Error("injected issue-update failure")
      },
    },
  }
  const p = executeApproveRule({ issueId: issue.id, body: BODY, scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg })
  const formID = await waitForForm(env.formHost)
  env.formHost.reply(formID, { choice: "confirm" })
  const res = await p
  assert.equal(res.ok, true, "the approval itself is recorded")
  assert.match(res.decisionId, /^DEC/)
  assert.match(res.warning ?? "", new RegExp(res.decisionId), "warning must carry the decisionId")
  assert.match(res.warning ?? "", /do NOT re-run approve/)
  assert.equal(await decisionsCount(env.storeRoot), 1, "no duplicate approval anywhere")
})

// ---------- delivery enable tool ----------

test("enable tool: full display with binding quadruple, confirm → delivery-enabled; re-run → alreadyEnabled, nothing new", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  const before = fs.readFileSync(env.target)
  const p = executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  const disp = env.formHost.displayOf(formID)
  assert.ok(disp.includes(BODY.split("\n")[0]))
  assert.ok(new RegExp(`ruleId=${rule.id} version=1 channel=system-ride`).test(disp), "binding quadruple displayed")
  assert.ok(/bodyHash=[0-9a-f]{64}/.test(disp))
  assert.ok(/PERSISTENT/.test(disp))
  env.formHost.reply(formID, { choice: "confirm" })
  const res = await p
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(res.decisionId, /^DEC/)
  assert.equal(res.version, 1)
  assert.equal(typeof res.bodyHash, "string")
  assert.match(res.note ?? "", /not retroactively removed|stops appending|withdraw/i)
  assert.equal(deriveDeliveryState(openStore(env.storeRoot).getRule(rule.id), openStore(env.storeRoot).listDecisions()).enabled, true)

  // duplicate → explicit alreadyEnabled, records NOTHING
  const res2 = await executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  assert.equal(res2.ok, true)
  assert.equal(res2.alreadyEnabled, true)
  assert.equal(res2.decisionId, res.decisionId)
  assert.equal(await decisionsCount(env.storeRoot), 2) // approve + first enable
  assert.deepEqual(fs.readFileSync(env.target), before)
})

test("enable tool on a DISABLED rule: refuses with fresh-approval-of-a-new-version message; never reuses old authorization", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  openStore(env.storeRoot).recordDecision({ kind: "disable", ruleId: rule.id })
  const res = await executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  assert.equal(res.ok, false)
  assert.equal(res.code, "MEMORY_RULE_DISABLED")
  assert.match(res.message, /NEW version/i)
  assert.match(res.message, /never a delivery switch|fresh/i)
  assert.equal(env.formHost.ids().length, 0, "no form for a refused enable")
  const kinds = openStore(env.storeRoot).listDecisions().map((d) => d.kind)
  assert.ok(!kinds.includes("delivery-enable"))
})

test("enable tool on unknown rule → MEMORY_RULE_NOT_FOUND; on patch-channel rule → MEMORY_CHANNEL_MISMATCH", async (t) => {
  const env = await makeEnv(t)
  assert.equal((await executeEnableDelivery({ ruleId: "RUL-missing" }, CTX_A, { cfg: env.cfg })).code, "MEMORY_RULE_NOT_FOUND")
  const { rule } = seedRule(env.storeRoot, { channel: "patch-human-apply", targets: [env.target] })
  assert.equal((await executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })).code, "MEMORY_CHANNEL_MISMATCH")
})

test("enable cancelled → nothing recorded; snapshot staleness on enable → stale", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  const p = executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  const formID = await waitForForm(env.formHost)
  env.formHost.reply(formID, { choice: "cancel" })
  const res = await p
  assert.equal(res.code, "MEMORY_CONFIRMATION_CANCELLED")
  assert.equal(await decisionsCount(env.storeRoot), 1)

  const p2 = executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  const formID2 = await waitForForm(env.formHost)
  openStore(env.storeRoot).recordDecision({ kind: "disable", ruleId: rule.id }) // state moved
  env.formHost.reply(formID2, { choice: "confirm" })
  const res2 = await p2
  assert.equal(res2.ok, false)
  assert.equal(res2.code, "MEMORY_CONFIRMATION_STALE")
})

// ---------- re-approve invalidates delivery ----------

test("re-approve to a new version auto-invalidates the old delivery-enable (quadruple breaks)", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  const p = executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  env.formHost.reply(await waitForForm(env.formHost), { choice: "confirm" })
  const en = await p
  assert.equal(en.ok, true)
  let store = openStore(env.storeRoot)
  assert.equal(deriveDeliveryState(store.getRule(rule.id), store.listDecisions()).enabled, true)

  // re-approve as v2 through the tool (fresh form + confirm)
  const p2 = executeApproveRule({ ruleId: rule.id, body: rule.body + "\nv2 line", scope: { kind: "project" }, channel: "system-ride" }, CTX_A, { cfg: env.cfg })
  env.formHost.reply(await waitForForm(env.formHost), { choice: "confirm" })
  const ap2 = await p2
  assert.equal(ap2.ok, true, JSON.stringify(ap2))
  assert.equal(ap2.version, 2)
  store = openStore(env.storeRoot)
  const st = deriveDeliveryState(store.getRule(rule.id), store.listDecisions())
  assert.equal(st.enabled, false, "v2 approval must reset delivery to disabled")
  assert.match(st.reason, /version|mismatch|enable/i)
  // the v1 enable decision remains on the audit trail (stop ≠ erase)
  assert.equal(store.listDecisions().filter((d) => d.kind === "delivery-enable").length, 1)
})

// ---------- stop-class tools (no second confirmation) ----------

test("disable_delivery tool: NO form, records stop decision, wording never claims history is cleared", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  const p = executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  env.formHost.reply(await waitForForm(env.formHost), { choice: "confirm" })
  await p
  const before = fs.readFileSync(env.target)

  const res = await executeDisableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(res.decisionId, /^DEC/)
  assert.match(res.note, /only stops appending/i)
  assert.match(res.note, /not retroactively removed/i)
  assert.doesNotMatch(res.note, /removed from history|history is cleared|erased/i)
  assert.equal(env.formHost.ids().length, 1, "stop-class never shows a form")
  const store = openStore(env.storeRoot)
  assert.equal(deriveDeliveryState(store.getRule(rule.id), store.listDecisions()).enabled, false)
  assert.deepEqual(fs.readFileSync(env.target), before)
  assert.equal(auditLines(env.storeRoot).at(-1).outcome, "recorded")
})

test("disable_rule tool: store status disabled, targets preserved, AGENTS.md bytes unchanged, residue wording present", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot, { targets: [] })
  const beforeBytes = fs.readFileSync(env.target)
  const decisionsBefore = await decisionsCount(env.storeRoot)

  const res = await executeDisableRule({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  assert.equal(res.ok, true, JSON.stringify(res))
  const store = openStore(env.storeRoot)
  const after = store.getRule(rule.id)
  assert.equal(after.status, "disabled")
  assert.deepEqual(after.targets, rule.targets, "targets preserved")
  assert.deepEqual(fs.readFileSync(env.target), beforeBytes)
  assert.equal(await decisionsCount(env.storeRoot), decisionsBefore + 1)
  assert.match(res.note, /residue withdrawn|disabled-in-store ≠/)
  assert.match(res.note, /not retroactively removed|stays in target files|history/i)
  assert.doesNotMatch(res.note, /removed from history|cleaned up|erased/i)
})

test("stop-class refusals: unknown rule, disable on non-active rule, subagent gate", async (t) => {
  const env = await makeEnv(t)
  assert.equal((await executeDisableDelivery({ ruleId: "RUL-missing" }, CTX_A, { cfg: env.cfg })).code, "MEMORY_RULE_NOT_FOUND")
  assert.equal((await executeDisableRule({ ruleId: "RUL-missing" }, CTX_A, { cfg: env.cfg })).code, "MEMORY_RULE_NOT_FOUND")
  const { rule } = seedRule(env.storeRoot)
  openStore(env.storeRoot).recordDecision({ kind: "disable", ruleId: rule.id })
  assert.equal((await executeDisableRule({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })).code, "MEMORY_RULE_NOT_ACTIVE")
  assert.equal((await executeDisableDelivery({ ruleId: rule.id }, { sessionID: "ses_child_a" }, { cfg: env.cfg })).code, "MEMORY_SESSION_REJECTED")
})

// ---------- decision durability ----------

test("old decisions survive: disable does not erase the approve record; byte-identical AGENTS.md throughout", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot, { targets: [] })
  const beforeBytes = fs.readFileSync(env.target)
  const p = executeEnableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  env.formHost.reply(await waitForForm(env.formHost), { choice: "confirm" })
  await p
  await executeDisableDelivery({ ruleId: rule.id }, CTX_A, { cfg: env.cfg })
  const store = openStore(env.storeRoot)
  const kinds = store.listDecisions().map((d) => d.kind)
  assert.deepEqual(kinds, ["approve", "delivery-enable", "delivery-disable"], "history preserved in order")
  assert.deepEqual(fs.readFileSync(env.target), beforeBytes)
})

// ---------- CLI through the shared service layer ----------

test("CLI delivery-disable records with NO confirmation prompt (bug ③ fixed) via the same critical section", async (t) => {
  const env = await makeEnv(t)
  const { rule } = seedRule(env.storeRoot)
  const { main } = await import("../lib/memory/cli/cli.mjs")
  const prompts = []
  const io = {
    isTTY: true,
    print: () => {},
    confirm: (p) => {
      prompts.push(p)
      return false // any confirm attempt would cancel the flow
    },
    choose: () => {
      throw new Error("no choose expected")
    },
    input: () => {
      throw new Error("no input expected")
    },
    inputLines: () => {
      throw new Error("no inputLines expected")
    },
    close: () => {},
  }
  const code = await main(["delivery-disable", rule.id, "--root", env.storeRoot], { env: {}, cwd: env.proj, home: env.base, io })
  assert.equal(code, 0)
  assert.equal(prompts.length, 0, "stop-class must not ask again")
  const store = openStore(env.storeRoot)
  assert.equal(store.listDecisions().at(-1).kind, "delivery-disable")
})

