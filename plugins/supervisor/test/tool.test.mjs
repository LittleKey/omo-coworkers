// T1/T2 for the report_correction tool face (m1-plan §4-T1/T2, decisions
// D1/D3/D4; design v5.0 II.2/II.3). T2 = source & idempotency semantics via a
// fake host DB (node:sqlite, same shape P0 verified); T1 = host regression at
// unit level (enable off/on, registration fault isolation).
//
// Isolation mirrors test/store.test.mjs: every test operates on its own
// mkdtemp directories (fake host DB, store root, mock dir, log path); the
// real ~/.local/share/opencode-supervisor/ and the real host opencode.db are
// never touched (defaultMemoryRoot()/defaultHostDbPath() are deliberately not
// exercised — paths are always injected).

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"

import {
  initStore,
  openStore,
  EVIDENCE_MAX_CHARS,
  FILE_LOCK,
} from "../lib/memory/store.mjs"
import { validateEvidence } from "../lib/memory/evidence.mjs"
import {
  TOOL_NAME,
  FROZEN_TOOL_DESCRIPTION,
  resolveMemoryOptions,
  registerMemoryTool,
} from "../lib/memory/tool.mjs"
import supervisor from "../index.js"

// ---------- helpers ----------

const QUICK = { lockTimeoutMs: 200, lockPollMs: 5, pidGraceMs: 10 }

const PROJ_A = "proj_a"
const PROJ_B = "proj_b"

function withTmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** Fake host opencode.db with the P0-verified table shape (subset used by the SQL). */
function createHostDb(t) {
  const dir = withTmp(t, "hostdb-")
  const dbPath = path.join(dir, "opencode.db")
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, agent TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
      seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `)
  const addSession = (id, projectId, parentId) =>
    db
      .prepare("INSERT INTO session_v2 (id, project_id, parent_id, agent) VALUES (?,?,?,?)")
      .run(id, projectId, parentId, parentId ? "subagent" : "build")
  const addMsg = (id, sessionId, type, text) =>
    db
      .prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, sessionId, type, 1, 1, 1, JSON.stringify({ text }))

  addSession("ses_root_a", PROJ_A, null)
  addMsg("msg_user_a1", "ses_root_a", "user", "prefer const over let in this repo")
  addMsg("msg_assist_a1", "ses_root_a", "assistant", "assistant text a1")
  addMsg("msg_long_a", "ses_root_a", "user", "x".repeat(5000))
  // the "triggering" current-turn user message in the calling session —
  // inserted last so ORDER BY rowid DESC (current-turn fallback) picks it
  addMsg("msg_trigger_a", "ses_root_a", "user", "请记住这个纠正")

  addSession("ses_root_a2", PROJ_A, null)
  addMsg("msg_user_a2", "ses_root_a2", "user", "cross-session same-project correction")

  addSession("ses_child_a", PROJ_A, "ses_root_a")
  addMsg("msg_user_child", "ses_child_a", "user", "synthetic subagent task prompt")

  addSession("ses_root_b", PROJ_B, null)
  addMsg("msg_user_b1", "ses_root_b", "user", "other-project correction")

  // root session whose host row carries no project identity (fail-closed case)
  addSession("ses_noproj", null, null)

  // root session with NO user message (current-turn fallback must fail-closed)
  addSession("ses_nouser", PROJ_A, null)
  addMsg("msg_assist_nouser", "ses_nouser", "assistant", "assistant-only session")

  db.close()
  return dbPath
}

function makeStoreRoot(t) {
  const dir = withTmp(t, "memtool-")
  const root = path.join(dir, "memory")
  initStore(root)
  return root
}

function snapshot(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name !== FILE_LOCK) {
        out.push([path.relative(root, p), createHash("sha256").update(fs.readFileSync(p)).digest("hex")])
      }
    }
  }
  walk(root)
  return out
}

/** Mock v2 ctx with a recording tool surface. */
function makeCtx({ memory, throwInTransform = false } = {}) {
  const state = { added: [], transformCalls: 0, reloaded: 0 }
  const ctx = {
    options: { mode: "inject", memory },
    // Deliberately WRONG instance location (canary): per the plugin API doc,
    // ctx.location is the plugin instance's load location, not the session's.
    // The tool must derive project identity from the host DB session row and
    // ignore this value entirely — the happy-path tests would fail if it
    // leaked back in.
    location: { project: { id: "proj_plugin_instance" } },
    tool: {
      transform(fn) {
        state.transformCalls++
        if (throwInTransform) throw new Error("boom-transform")
        fn({
          add(tool) {
            state.added.push(tool)
          },
        })
      },
      async reload() {
        state.reloaded++
      },
    },
  }
  return { ctx, state }
}

/** Register with memory enabled and return the report_correction tool. */
async function registeredTool(t, { dbPath, storeRoot, mockDir, mock = false } = {}) {
  const { ctx, state } = makeCtx({
    memory: { enable: true, mock, dbPath, storeRoot, mockDir },
  })
  const res = await registerMemoryTool(ctx)
  assert.equal(res.registered, true)
  const tool = state.added.find((tl) => tl.name === TOOL_NAME)
  assert.ok(tool, "report_correction must be among added tools")
  return { tool, ctx, state }
}

function expectReject(res, fragment) {
  assert.equal(res.ack, undefined, "rejection must carry no ack receipt")
  assert.equal(res.ok, false)
  assert.equal(typeof res.error, "string")
  if (fragment) assert.ok(res.error.includes(fragment), `error ${JSON.stringify(res.error)} must include ${JSON.stringify(fragment)}`)
}

// ---------- evidence.mjs (D4 unit) ----------

test("evidence: missing host DB file → fail-closed rejection", (t) => {
  const res = validateEvidence({
    dbPath: path.join(withTmp(t, "evmissing-"), "absent.db"),
    messageId: "msg_user_a1",
    currentProjectId: PROJ_A,
  })
  assert.equal(res.ok, false)
  assert.match(res.reason, /fail-closed|not found/)
})

test("evidence: malformed input → rejected without touching the DB", (t) => {
  assert.equal(validateEvidence({ dbPath: "/unused", messageId: "", currentProjectId: PROJ_A }).ok, false)
  assert.equal(validateEvidence({ dbPath: "/unused", messageId: "m", currentProjectId: undefined }).ok, false)
})

// ---------- T2 source semantics (each via the real tool.execute) ----------

test("T2 same-project cross-session user message → accepted, recorded in real store", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  // caller ses_root_a, evidence from ses_root_a2 (different root session, same project)
  const res = await tool.execute({ description: "记住这个纠正", evidence: "msg_user_a2" }, { sessionID: "ses_root_a" })
  assert.equal(res.ack, true)
  assert.match(res.issueId, /^ISS-/)
  assert.match(res.eventId, /^EVT-/)
  assert.equal(typeof res.note, "string")
  assert.equal(res.evidenceVia, "explicit-ids")
  assert.ok(!("mock" in res), "non-mock receipt must not carry mock flag")

  const store = openStore(storeRoot, QUICK)
  const events = store.listEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].source.messageId, "msg_user_a2")
  assert.equal(events[0].source.sessionId, "ses_root_a2")
  assert.equal(events[0].source.projectId, PROJ_A)
  assert.equal(events[0].status, "pending")
})

test("T2 cross-project evidence → rejected", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: "msg_user_b1" }, { sessionID: "ses_root_a" })
  expectReject(res, "another project")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 assistant message as evidence → rejected", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: "msg_assist_a1" }, { sessionID: "ses_root_a" })
  expectReject(res, "not a user message")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 unknown message id → rejected fail-closed", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: "msg_nope" }, { sessionID: "ses_root_a" })
  expectReject(res, "does not exist")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 evidence from a subagent session (parent_id set) → rejected", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: "msg_user_child" }, { sessionID: "ses_root_a" })
  expectReject(res, "subagent session")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 subagent caller (current session parent_id non-null) → rejected", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: "msg_user_a1" }, { sessionID: "ses_child_a" })
  expectReject(res, "can only be used in a root session")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 unknown current session id → rejected fail-closed", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: "msg_user_a1" }, { sessionID: "ses_unknown" })
  expectReject(res, "fail-closed")
})

test("T2 current session row with NULL project_id → rejected fail-closed", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: "msg_user_a1" }, { sessionID: "ses_noproj" })
  expectReject(res, "project identity")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 caller session in project B, evidence in project A → rejected (session identity, not instance location)", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  // caller session row is proj_b; the plugin instance location is the
  // "proj_plugin_instance" canary — neither may make proj_a evidence pass
  const res = await tool.execute({ description: "x", evidence: "msg_user_a1" }, { sessionID: "ses_root_b" })
  expectReject(res, "another project")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 project identity derives from the caller session row, not the plugin instance", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  // caller ses_root_b (proj_b), evidence from ses_root_b itself → accepted
  // with the SESSION's project even though ctx.location says otherwise
  const res = await tool.execute({ description: "b-side correction", evidence: "msg_user_b1" }, { sessionID: "ses_root_b" })
  assert.equal(res.ack, true)
  const store = openStore(storeRoot, QUICK)
  const events = store.listEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].source.projectId, PROJ_B)
  assert.equal(events[0].source.sessionId, "ses_root_b")
})

test("T2 unknown issueId → rejected, no issue silently created", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const before = openStore(storeRoot, QUICK).listIssues().length
  const res = await tool.execute(
    { description: "x", evidence: "msg_user_a1", issueId: "ISS_MISSING" },
    { sessionID: "ses_root_a" },
  )
  expectReject(res, "does not exist in the store")
  assert.equal(openStore(storeRoot, QUICK).listIssues().length, before)
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 cross-project issueId → rejected", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const store = openStore(storeRoot, QUICK)
  store.upsertIssue({ title: "seeded other-project issue", projectId: PROJ_B })
  const seeded = store.listIssues().find((i) => i.projectId === PROJ_B)
  assert.ok(seeded)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute(
    { description: "x", evidence: "msg_user_a1", issueId: seeded.id },
    { sessionID: "ses_root_a" },
  )
  expectReject(res, "another project")
})

test("T2 serial + concurrent duplicate sources → exactly one event, duplicate receipts", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })

  const first = await tool.execute({ description: "d1", evidence: "msg_user_a1" }, { sessionID: "ses_root_a" })
  assert.equal(first.ack, true)
  const second = await tool.execute({ description: "d2", evidence: "msg_user_a1" }, { sessionID: "ses_root_a" })
  assert.equal(second.ack, true)
  assert.equal(second.duplicate, true, "serial repeat of the same source must return duplicate")
  assert.equal(second.issueId, first.issueId)

  // concurrent same-source calls (fresh store/session so counts are exact)
  const storeRoot2 = makeStoreRoot(t)
  const { tool: tool2 } = await registeredTool(t, { dbPath, storeRoot: storeRoot2 })
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      tool2.execute({ description: `c${i}`, evidence: "msg_user_a2" }, { sessionID: "ses_root_a" }),
    ),
  )
  for (const r of results) assert.equal(r.ack, true)
  const issueIds = new Set(results.map((r) => r.issueId))
  assert.equal(issueIds.size, 1, "all concurrent same-source calls must land on one issue")
  const store2 = openStore(storeRoot2, QUICK)
  assert.equal(store2.listEvents().length, 1, "concurrent duplicates must produce exactly one event")
})

test("T2 multi-evidence call: any invalid id rejects the whole call", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute(
    { description: "x", evidence: ["msg_user_a1", "msg_user_b1"] },
    { sessionID: "ses_root_a" },
  )
  expectReject(res, "msg_user_b1")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0, "no partial writes on rejected call")
})

test("T2 evidence arg shape violations → rejected", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const call = (evidence) => tool.execute({ description: "x", evidence }, { sessionID: "ses_root_a" })
  // (note: [] and "" now mean "omitted" → current-turn fallback, covered by
  // the fallback tests below — they are no longer shape violations)
  expectReject(await call(["a", "b", "c", "d"]), "1..3")
  expectReject(await call([42]), "1..3")
  expectReject(await tool.execute({ description: "   ", evidence: "msg_user_a1" }, { sessionID: "ses_root_a" }), "description")
})

// ---------- T2 current-turn fallback (AMENDMENT, live m01516) ----------

test("T2 fallback: evidence omitted → triggering current-turn user message recorded", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "记住这次纠正" }, { sessionID: "ses_root_a" })
  assert.equal(res.ack, true)
  assert.equal(res.evidenceVia, "current-turn-fallback")
  const events = openStore(storeRoot, QUICK).listEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].source.messageId, "msg_trigger_a", "fallback must target the latest user row")
  assert.equal(events[0].source.sessionId, "ses_root_a")
})

test("T2 fallback: unresolvable ACP refs (evidence=[\"m00001\"]) → triggering message recorded", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "记住这次纠正", evidence: ["m00001"] }, { sessionID: "ses_root_a" })
  assert.equal(res.ack, true)
  assert.equal(res.evidenceVia, "current-turn-fallback")
  const events = openStore(storeRoot, QUICK).listEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].source.messageId, "msg_trigger_a")
})

test("T2 fallback: unresolvable NON-ref garbage → hard reject, no silent fallback", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: ["garbage-not-a-ref"] }, { sessionID: "ses_root_a" })
  expectReject(res, "garbage-not-a-ref")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 fallback: mixed unresolvable ref + valid id → hard reject (no fallback)", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute(
    { description: "x", evidence: ["m00001", "msg_user_a2"] },
    { sessionID: "ses_root_a" },
  )
  expectReject(res, "m00001")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 fallback: session without any user message → rejected fail-closed", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x" }, { sessionID: "ses_nouser" })
  expectReject(res, "triggering user message")
  assert.equal(openStore(storeRoot, QUICK).listEvents().length, 0)
})

test("T2 excerpt truncated to EVIDENCE_MAX_CHARS", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "long", evidence: "msg_long_a" }, { sessionID: "ses_root_a" })
  assert.equal(res.ack, true)
  const ev = openStore(storeRoot, QUICK).listEvents()[0]
  assert.equal(ev.evidence.excerpt.length, EVIDENCE_MAX_CHARS)
})

// ---------- T2 mock receipt (II.2) ----------

test("T2 mock mode: full validation runs, zero production writes, isolated receipt", async (t) => {
  const dbPath = createHostDb(t)
  const dir = withTmp(t, "memmock-")
  const storeRoot = path.join(dir, "memory")
  initStore(storeRoot)
  const mockDir = path.join(dir, "mock")
  const { tool } = await registeredTool(t, { dbPath, storeRoot, mockDir, mock: true })

  const before = snapshot(storeRoot)
  const res = await tool.execute({ description: "mock it", evidence: "msg_user_a1" }, { sessionID: "ses_root_a" })
  assert.equal(res.ack, true)
  assert.equal(res.mock, true)
  assert.equal(res.issueId, "MOCK")
  assert.match(res.eventId, /^MOCK-/)
  assert.deepEqual(snapshot(storeRoot), before, "production store bytes must not change in mock mode")

  const files = fs.readdirSync(mockDir)
  assert.equal(files.length, 1)
  const receipt = JSON.parse(fs.readFileSync(path.join(mockDir, files[0]), "utf8").trim().split("\n").pop())
  assert.equal(receipt.mock, true)
  assert.equal(receipt.sessionId, "ses_root_a")
  assert.deepEqual(receipt.evidence, ["msg_user_a1"])

  // mock still validates: bad evidence is rejected even in mock mode
  const bad = await tool.execute({ description: "x", evidence: "msg_user_b1" }, { sessionID: "ses_root_a" })
  expectReject(bad, "another project")
})

// ---------- T2 store-missing (D5: never auto-create) ----------

test("T2 missing store → explicit init hint, directory never created", async (t) => {
  const dbPath = createHostDb(t)
  const dir = withTmp(t, "memmissing-")
  const storeRoot = path.join(dir, "absent-memory")
  const { tool } = await registeredTool(t, { dbPath, storeRoot })
  const res = await tool.execute({ description: "x", evidence: "msg_user_a1" }, { sessionID: "ses_root_a" })
  expectReject(res, "init")
  assert.equal(fs.existsSync(storeRoot), false, "store root must not be auto-created")
})

// ---------- T1 host regression (unit level) ----------

test("T1 memory.enable off (default) → not registered, tool surface untouched", async (t) => {
  for (const memory of [undefined, {}, { enable: false }, { enable: "yes" }]) {
    const { ctx, state } = makeCtx({ memory })
    const res = await registerMemoryTool(ctx)
    assert.equal(res.registered, false)
    assert.equal(state.transformCalls, 0)
    assert.equal(state.reloaded, 0)
    assert.equal(state.added.length, 0)
  }
})

test("T1 memory.enable on → the four-tool face registered, each codemode:false, one reload", async (t) => {
  const dbPath = createHostDb(t)
  const { ctx, state } = makeCtx({ memory: { enable: true, dbPath } })
  const res = await registerMemoryTool(ctx)
  assert.equal(res.registered, true)
  assert.deepEqual(res.tools, ["report_correction", "draft_rule", "prepare_publish", "memory_status"])
  assert.equal(state.transformCalls, 4)
  assert.equal(state.reloaded, 1)
  assert.equal(state.added.length, 4)
  assert.deepEqual(
    state.added.map((tl) => tl.name),
    ["report_correction", "draft_rule", "prepare_publish", "memory_status"],
  )
  for (const tool of state.added) {
    assert.deepEqual(tool.options, { codemode: false })
    assert.equal(typeof tool.description, "string")
    assert.equal(typeof tool.execute, "function")
  }
  const report = state.added.find((tl) => tl.name === TOOL_NAME)
  assert.equal(report.description, FROZEN_TOOL_DESCRIPTION)
})

test("T1 resolveMemoryOptions: only ===true enables; unknown keys ignored", () => {
  assert.equal(resolveMemoryOptions(undefined).enable, false)
  assert.equal(resolveMemoryOptions({ memory: { enable: true, nonsense: 1 } }).enable, true)
  const cfg = resolveMemoryOptions({ memory: { enable: true, mock: true, dbPath: "/d", storeRoot: "/s", mockDir: "/m" } })
  assert.deepEqual(cfg, { enable: true, mock: true, dbPath: "/d", storeRoot: "/s", mockDir: "/m" })
})

test("T1 full supervisor.setup with throwing transform → setup survives, context hook intact, fault logged", async (t) => {
  const dbPath = createHostDb(t)
  const dir = withTmp(t, "memsetup-")
  const logPath = path.join(dir, "supervisor.log.jsonl")
  const state = { hooks: [] }
  const ctx = {
    options: { mode: "inject", logPath, memory: { enable: true, dbPath } },
    location: { project: { id: PROJ_A } },
    event: { subscribe: async function* () {} },
    session: {
      get: async () => null,
      hook: async (name, fn) => {
        state.hooks.push([name, fn])
      },
    },
    tool: {
      transform() {
        throw new Error("boom-transform")
      },
      async reload() {},
    },
  }
  // must not throw despite the host tool surface exploding
  await supervisor.setup(ctx)
  assert.equal(state.hooks.length, 1, "context hook must still be registered")
  assert.equal(state.hooks[0][0], "context")
  const logText = fs.readFileSync(logPath, "utf8")
  assert.ok(logText.includes("memory.register"), "registration fault must be logged, not propagated")
})
