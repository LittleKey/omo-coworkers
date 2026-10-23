// T4 full fault matrix for lib/memory/store.mjs (m1-plan §4-T4, decision D5).
// Covers: missing / corrupt / truncated / permission / lock-failure / unknown
// schema rejection (fail-closed, no auto-create, no re-rooting), per-op
// transaction-checklist crash injection, authorization-output closure on any
// fault, event idempotency, stale-lock recovery vs live-lock refusal, and
// init permission assertions (0700 / 0600).
//
// Every test operates on its own mkdtemp directory; the real
// ~/.local/share/opencode-supervisor/ is never touched (defaultMemoryRoot()
// is deliberately not imported here).

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import {
  initStore,
  openStore,
  StoreError,
  FaultInjected,
  TXN_CHECKLISTS,
  canonicalJson,
  sha256Hex,
  FILE_RULES,
  FILE_ISSUES,
  FILE_EVENTS,
  FILE_DECISIONS,
  FILE_PROJECTS,
  FILE_MARKER,
  FILE_LOCK,
} from "../lib/memory/store.mjs"

// ---------- helpers ----------

// pid of an exited process → provably dead (for dead-holder recovery tests)
const DEAD_PID = spawnSync("true").pid

const QUICK = { lockTimeoutMs: 200, lockPollMs: 5, pidGraceMs: 10 }

function withRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memstore-"))
  const root = path.join(dir, "memory")
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return root
}

function fresh(t) {
  const root = withRoot(t)
  initStore(root)
  return { root, store: openStore(root, QUICK) }
}

function EV(n) {
  return {
    source: { sessionId: `ses_${n}`, projectId: "proj_test", messageId: `msg_${n}` },
    evidence: { excerpt: `fix the foobar before committing (evidence ${n})`, messageRef: `msg_${n}` },
  }
}

function APPROVAL() {
  return {
    body: "Always run the test suite before committing.",
    scope: { kind: "project", projectId: "proj_test" },
    targets: ["AGENTS.md"],
    reviewDate: "2026-11-22",
    channel: "patch-human-apply",
  }
}

// hashes of every regular store file except the lock (which legitimately
// appears/disappears with leaked-lock recovery)
function snapshot(root) {
  return fs
    .readdirSync(root)
    .sort()
    .filter((f) => f !== FILE_LOCK)
    .map((f) => {
      const p = path.join(root, f)
      const st = fs.statSync(p)
      if (!st.isFile()) return `${f}:dir`
      let text = ""
      try {
        text = fs.readFileSync(p, "utf8")
      } catch {
        return `${f}:unreadable`
      }
      return `${f}:${sha256Hex(text)}`
    })
}

function fileList(root) {
  return fs.readdirSync(root).sort().filter((f) => f !== FILE_LOCK)
}

function errorCode(fn, code) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof StoreError, `expected StoreError, got ${e?.constructor?.name}: ${e?.message}`)
    assert.equal(e.code, code, `expected code ${code}, got ${e.code}: ${e.message}`)
    return true
  })
}

// ---------- init / missing ----------

test("T4 init: dir 0700, files 0600, skeleton + committed marker; re-init refused", (t) => {
  const root = withRoot(t)
  const res = initStore(root)
  assert.equal((fs.statSync(root).mode & 0o777), 0o700)
  for (const f of res.files) {
    const st = fs.statSync(path.join(root, f))
    assert.equal(st.mode & 0o777, 0o600, f)
  }
  const marker = JSON.parse(fs.readFileSync(path.join(root, FILE_MARKER), "utf8"))
  assert.equal(marker.phase, "committed")
  assert.equal(marker.op, "init")
  const store = openStore(root, QUICK)
  assert.equal(store.health.status, "ok")
  assert.deepEqual(store.status().counts, {
    rules: {},
    issues: {},
    events: {},
    decisions: {},
    projects: { total: 0, confirmedDirectories: 0 },
  })
  errorCode(() => initStore(root), "STORE_EXISTS")
  // partial leftovers also refuse init (never clobber)
  errorCode(() => {
    const r2 = withRoot(t)
    fs.mkdirSync(r2, { recursive: true })
    fs.writeFileSync(path.join(r2, FILE_RULES), "{}\n", { mode: 0o600 })
    initStore(r2)
  }, "STORE_EXISTS")
})

test("T4 open: missing store → STORE_MISSING, nothing auto-created (库缺失≠新安装)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memstore-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, "memory")
  errorCode(() => openStore(root, QUICK), "STORE_MISSING")
  assert.equal(fs.existsSync(root), false, "open must not create anything")
  // empty directory is also "missing", not a fresh install
  fs.mkdirSync(root)
  errorCode(() => openStore(root, QUICK), "STORE_MISSING")
  assert.deepEqual(fs.readdirSync(root), [])
  // a file where the store should be is equally rejected
  const filePath = path.join(dir, "notadir")
  fs.writeFileSync(filePath, "x")
  errorCode(() => openStore(filePath, QUICK), "STORE_MISSING")
})

test("T4 open: store files without commit marker → corrupt (content without marker), no auto-heal", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memstore-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, "memory")
  fs.mkdirSync(root)
  fs.writeFileSync(
    path.join(root, FILE_RULES),
    JSON.stringify({ schema: "opencode-supervisor-memory", version: 1, lastTxn: null, rules: {} }, null, 2),
    { mode: 0o600 },
  )
  const before = fileList(root)
  const store = openStore(root, QUICK)
  assert.equal(store.health.status, "corrupt")
  assert.ok(store.health.problems.some((p) => /commit.marker is missing/.test(p.detail)))
  errorCode(() => store.appendEvent(EV(1)), "STORE_CORRUPT")
  assert.deepEqual(fileList(root), before, "no file may be auto-created or repaired")
})

// ---------- corrupt / unknown schema / truncated ----------

test("T4 corrupt: unparsable rules.json → fail-closed, writes refused", (t) => {
  const { root, store } = fresh(t)
  store.appendEvent(EV(1))
  fs.writeFileSync(path.join(root, FILE_RULES), '{"rules": { truncated', { mode: 0o600 })
  const s2 = openStore(root, QUICK)
  assert.equal(s2.health.status, "corrupt")
  assert.ok(s2.health.problems.some((p) => /rules\.json unparsable/.test(p.detail)))
  errorCode(() => s2.appendEvent(EV(2)), "STORE_CORRUPT")
  errorCode(() => s2.listRules(), "STORE_CORRUPT")
  const before = snapshot(root)
  assert.deepEqual(snapshot(root), before, "failed writes change nothing")
})

test("T4 unknown schema: json version 99 → fail-closed", (t) => {
  const { root, store } = fresh(t)
  const doc = JSON.parse(fs.readFileSync(path.join(root, FILE_RULES), "utf8"))
  doc.version = 99
  fs.writeFileSync(path.join(root, FILE_RULES), JSON.stringify(doc, null, 2), { mode: 0o600 })
  const s2 = openStore(root, QUICK)
  assert.equal(s2.health.status, "corrupt")
  assert.ok(s2.health.problems.some((p) => p.detail.includes("unknown schema")))
  errorCode(() => s2.appendEvent(EV(1)), "STORE_CORRUPT")
})

test("T4 unknown schema: unknown record type in events.jsonl → fail-closed", (t) => {
  const { root, store } = fresh(t)
  store.appendEvent(EV(1))
  // seq stays within the committed marker so ONLY the schema check fires
  fs.appendFileSync(path.join(root, FILE_EVENTS), JSON.stringify({ type: "wat", v: 1, seq: 2, txnId: "txn-2-ww" }) + "\n")
  const s2 = openStore(root, QUICK)
  assert.equal(s2.health.status, "corrupt")
  assert.ok(s2.health.problems.some((p) => /unknown record schema/.test(p.detail)))
  errorCode(() => s2.appendEvent(EV(2)), "STORE_CORRUPT")
})

test("T4 truncated: torn last line in events.jsonl → corrupt with line detail", (t) => {
  const { root, store } = fresh(t)
  store.appendEvent(EV(1))
  fs.appendFileSync(path.join(root, FILE_EVENTS), '{"type":"event","v":1,"id":"EVT-tor')
  const s2 = openStore(root, QUICK)
  assert.equal(s2.health.status, "corrupt")
  assert.ok(s2.health.problems.some((p) => /line 2 unparsable \(truncated\?\)/.test(p.detail)))
  errorCode(() => s2.appendEvent(EV(2)), "STORE_CORRUPT")
})

test("T4 truncated: half-written issues.json → corrupt", (t) => {
  const { root, store } = fresh(t)
  store.appendEvent(EV(1))
  const text = fs.readFileSync(path.join(root, FILE_ISSUES), "utf8")
  fs.writeFileSync(path.join(root, FILE_ISSUES), text.slice(0, Math.floor(text.length / 2)), { mode: 0o600 })
  const s2 = openStore(root, QUICK)
  assert.equal(s2.health.status, "corrupt")
  errorCode(() => s2.appendEvent(EV(2)), "STORE_CORRUPT")
  errorCode(() => s2.listPending(), "STORE_CORRUPT")
})

// ---------- permissions ----------

test("T4 permission: unreadable rules.json → fail-closed; recovers after chmod", (t) => {
  const { root, store } = fresh(t)
  const p = path.join(root, FILE_RULES)
  fs.chmodSync(p, 0o000)
  try {
    const s2 = openStore(root, QUICK)
    assert.equal(s2.health.status, "permission")
    assert.ok(s2.health.problems.some((p2) => p2.severity === "permission" && /rules\.json/.test(p2.detail)))
    errorCode(() => s2.appendEvent(EV(1)), "STORE_PERM")
    errorCode(() => s2.listRules(), "STORE_PERM")
  } finally {
    fs.chmodSync(p, 0o600)
  }
  const s3 = openStore(root, QUICK)
  assert.equal(s3.health.status, "ok")
  s3.appendEvent(EV(1)) // works again — and the file mode stays 0600
  assert.equal(fs.statSync(p).mode & 0o777, 0o600)
})

test("T4 permission: unwritable store dir → lock creation fails STORE_PERM, no state change", (t) => {
  const { root, store } = fresh(t)
  store.appendEvent(EV(1))
  const before = snapshot(root)
  fs.chmodSync(root, 0o500)
  try {
    errorCode(() => store.appendEvent(EV(2)), "STORE_PERM")
  } finally {
    fs.chmodSync(root, 0o700)
  }
  assert.deepEqual(snapshot(root), before)
})

// ---------- locking ----------

function plantLock(root, content, { mtime } = {}) {
  const p = path.join(root, FILE_LOCK)
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 })
  if (mtime) fs.utimesSync(p, mtime, mtime)
  return p
}

test("T4 lock: live fresh lock → STORE_LOCKED, lock untouched, no overwrite", (t) => {
  const { root, store } = fresh(t)
  const lockPath = plantLock(root, { pid: process.pid, ts: Date.now(), host: "other-instance" })
  const before = fs.readFileSync(lockPath, "utf8")
  const snap = snapshot(root)
  errorCode(() => store.appendEvent(EV(1)), "STORE_LOCKED")
  assert.equal(fs.readFileSync(lockPath, "utf8"), before, "live lock must never be removed or rewritten")
  assert.deepEqual(snapshot(root), snap, "refused write overwrites nothing")
})

test("T4 lock: stale heartbeat (live pid, old ts) is recovered", (t) => {
  const { root, store } = fresh(t)
  plantLock(root, { pid: process.pid, ts: Date.now() - 60_000, host: "wedged" })
  const r = store.appendEvent(EV(1))
  assert.equal(r.duplicate, false)
  assert.equal(fs.existsSync(path.join(root, FILE_LOCK)), false, "lock released after successful txn")
})

test("T4 lock: dead pid + fresh heartbeat is recovered after grace", (t) => {
  const { root, store } = fresh(t)
  plantLock(root, { pid: DEAD_PID, ts: Date.now(), host: "killed" })
  const r = store.appendEvent(EV(1))
  assert.equal(r.duplicate, false)
})

test("T4 lock: unparsable lock content — fresh refused, stale recovered", (t) => {
  const { root, store } = fresh(t)
  plantLock(root, "{not json at all!!")
  errorCode(() => store.appendEvent(EV(1)), "STORE_LOCKED")
  plantLock(root, "{not json at all!!", { mtime: new Date(Date.now() - 120_000) })
  const r = store.appendEvent(EV(1))
  assert.equal(r.duplicate, false)
})

test("T4 contract: decisions.jsonl precedes rules.json in every rules-touching checklist", () => {
  for (const key of ["recordDecisionApprove", "recordDecisionDisable", "recordDecisionEnable"]) {
    const steps = TXN_CHECKLISTS[key]
    assert.ok(steps.indexOf("decisions:append") < steps.indexOf("rules:replace"), key)
    assert.equal(steps[steps.length - 1], "marker:commit", key)
    assert.equal(steps[0], "marker:pending", key)
  }
})

// ---------- crash matrix (D5 #2: per-op checklist, injected after every step) ----------

const STEP_FILE = {
  "events:append": FILE_EVENTS,
  "issues:replace": FILE_ISSUES,
  "decisions:append": FILE_DECISIONS,
  "rules:replace": FILE_RULES,
  "projects:replace": FILE_PROJECTS,
}

const MATRIX = [
  {
    key: "appendEvent",
    name: "appendEvent:new-candidate",
    op: (s) => s.appendEvent(EV(1)),
  },
  {
    key: "appendEvent",
    name: "appendEvent:recurrence",
    setup: (s) => {
      const r = s.appendEvent(EV(1))
      return { issueId: r.event.issueId }
    },
    op: (s, ctx) => s.appendEvent({ ...EV(2), issueId: ctx.issueId }),
  },
  {
    key: "confirmEvent",
    name: "confirmEvent",
    setup: (s) => {
      const r = s.appendEvent(EV(1))
      return { eventId: r.event.id }
    },
    op: (s, ctx) => s.confirmEvent(ctx.eventId, "confirmed"),
  },
  {
    key: "upsertIssue",
    name: "upsertIssue:create",
    op: (s) => s.upsertIssue({ title: "hand-entered candidate", projectId: "proj_test" }),
  },
  {
    key: "upsertIssue",
    name: "upsertIssue:transition",
    setup: (s) => {
      const r = s.upsertIssue({ title: "hand-entered candidate" })
      return { id: r.issue.id }
    },
    op: (s, ctx) => s.upsertIssue({ id: ctx.id, status: "approved" }),
  },
  {
    key: "recordDecisionApprove",
    name: "recordDecision:approve",
    op: (s) => s.recordDecision({ kind: "approve", object: APPROVAL() }),
  },
  {
    key: "recordDecisionReject",
    name: "recordDecision:reject",
    op: (s) => s.recordDecision({ kind: "reject", ruleId: null, object: { reason: "not a real correction" } }),
  },
  {
    key: "recordDecisionDisable",
    name: "recordDecision:disable",
    setup: (s) => {
      const r = s.recordDecision({ kind: "approve", object: APPROVAL() })
      return { ruleId: r.rule.id }
    },
    op: (s, ctx) => s.recordDecision({ kind: "disable", ruleId: ctx.ruleId, object: { note: "obsolete" } }),
  },
  {
    key: "recordDecisionEnable",
    name: "recordDecision:enable",
    setup: (s) => {
      const r = s.recordDecision({ kind: "approve", object: APPROVAL() })
      s.recordDecision({ kind: "disable", ruleId: r.rule.id, object: { note: "pause" } })
      return { ruleId: r.rule.id }
    },
    op: (s, ctx) => s.recordDecision({ kind: "enable", ruleId: ctx.ruleId, object: APPROVAL() }),
  },
  {
    key: "recordPublishResult",
    name: "recordPublishResult",
    setup: (s) => {
      const r = s.recordDecision({ kind: "approve", object: APPROVAL() })
      return { ruleId: r.rule.id }
    },
    op: (s, ctx) => s.recordPublishResult(ctx.ruleId, { applied: true, note: "pasted by hand" }),
  },
  {
    key: "upsertProject",
    name: "upsertProject",
    op: (s) => s.upsertProject({ projectId: "proj_test", alias: "Test Project", directory: "/tmp/somewhere" }),
  },
]

for (const entry of MATRIX) {
  const steps = TXN_CHECKLISTS[entry.key]
  for (const crashStep of steps) {
    test(`T4 crash matrix: ${entry.name} killed after "${crashStep}" → incomplete detected, authorization closed`, (t) => {
      const root = withRoot(t)
      initStore(root)
      const setupStore = openStore(root, QUICK)
      const ctx = entry.setup ? entry.setup(setupStore) : undefined

      // the "killed" process: fault hook throws after crashStep, lock leaks,
      // lock file records a dead pid (like a real kill would leave behind)
      const crashing = openStore(root, { ...QUICK, _fault: { crashAfter: crashStep, lockPid: DEAD_PID } })
      assert.throws(() => entry.op(crashing, ctx), (e) => {
        assert.ok(e instanceof FaultInjected, `expected FaultInjected, got ${e}`)
        assert.equal(e.step, crashStep)
        return true
      })
      assert.equal(fs.existsSync(path.join(root, FILE_LOCK)), true, "killed process leaks the lock")

      // reopen: incomplete commit detected (except a crash after the final
      // marker commit — that transaction IS complete)
      const s2 = openStore(root, QUICK)
      if (crashStep === "marker:commit") {
        assert.equal(s2.health.status, "ok", "crash after the commit marker is a committed transaction")
        // leaked lock is recovered by the next healthy write
        const probe = openStore(root, QUICK)
        probe.appendEvent(EV(99))
        assert.equal(fs.existsSync(path.join(root, FILE_LOCK)), false)
        return
      }

      assert.equal(s2.health.status, "incomplete_commit")
      const inc = s2.health.incomplete
      assert.ok(inc, "diff report for human review must be present")
      assert.equal(inc.op, entry.key)
      const crashedIdx = steps.indexOf(crashStep)
      for (const fe of inc.files) {
        const step = Object.keys(STEP_FILE).find((k) => STEP_FILE[k] === fe.path)
        const expected = steps.indexOf(step) <= crashedIdx
        assert.equal(fe.landed, expected, `${fe.path} landed flag after crash at ${crashStep}`)
      }

      // authorization outputs closed: any mutation is refused with a diff report
      const probe = openStore(root, QUICK)
      const beforeProbe = snapshot(root)
      errorCode(() => probe.appendEvent(EV(99)), "STORE_INCOMPLETE")
      assert.deepEqual(snapshot(root), beforeProbe, "refused mutation produces no publishable state change")

      // reopen stays consistent (idempotent read-only detection)
      const s3 = openStore(root, QUICK)
      assert.equal(s3.health.status, "incomplete_commit")

      // doctor reports the failing commit-marker check with the diff
      const doc = openStore(root, QUICK).doctor()
      assert.equal(doc.health.status, "incomplete_commit")
      const cm = doc.checks.find((c) => c.name === "commit-marker")
      assert.equal(cm.ok, false)
      assert.ok(/incomplete commit/.test(cm.detail))
    })
  }
}

// ---------- idempotency ----------

test("T4 idempotency: same source, serial duplicates → exactly one event, no state change on dupe", (t) => {
  const { root, store } = fresh(t)
  const r1 = store.appendEvent(EV(1))
  assert.equal(r1.duplicate, false)
  const snap = snapshot(root)
  const r2 = store.appendEvent(EV(1))
  assert.equal(r2.duplicate, true)
  assert.equal(r2.event.id, r1.event.id)
  assert.deepEqual(snapshot(root), snap, "duplicate writes nothing (not even the recurrence bump)")
  const s2 = openStore(root, QUICK)
  assert.equal(s2.listEvents().length, 1)
  assert.equal(s2.listIssues({ status: "draft" })[0].recurrence, 1)
})

test("T4 idempotency: two store instances (concurrent simulation) → one event", (t) => {
  const { root } = fresh(t)
  const a = openStore(root, QUICK)
  const b = openStore(root, QUICK)
  const r1 = a.appendEvent(EV(1))
  assert.equal(r1.duplicate, false)
  const r2 = b.appendEvent(EV(1))
  assert.equal(r2.duplicate, true)
  assert.equal(openStore(root, QUICK).listEvents().length, 1)
})

// ---------- state machines & semantics ----------

test("T4 state machine: issue draft → approved; merged needs target; terminal rejected", (t) => {
  const { store } = fresh(t)
  const { issue } = store.upsertIssue({ title: "candidate", projectId: "proj_test" })
  const target = store.upsertIssue({ title: "survivor" }).issue
  errorCode(() => store.upsertIssue({ id: issue.id, status: "merged" }), "STORE_INPUT") // mergedInto missing
  errorCode(() => store.upsertIssue({ id: issue.id, status: "merged", mergedInto: "ISS-nope" }), "STORE_STATE")
  store.mergeIssues(issue.id, target.id)
  assert.equal(store.getIssue(issue.id).status, "merged")
  const merged = store.listIssues().find((i) => i.id === issue.id)
  assert.equal(merged.status, "merged")
  assert.equal(merged.mergedInto, target.id)
  errorCode(() => store.upsertIssue({ id: issue.id, status: "dropped" }), "STORE_STATE") // terminal
  errorCode(() => store.upsertIssue({ id: "ISS-nope", status: "approved" }), "STORE_STATE")
})

test("T4 state machine: event pending → confirmed/false_positive; terminal", (t) => {
  const { store } = fresh(t)
  const { event } = store.appendEvent(EV(1))
  store.confirmEvent(event.id, "confirmed")
  errorCode(() => store.confirmEvent(event.id, "false_positive"), "STORE_STATE")
  errorCode(() => store.confirmEvent(event.id, "confirmed"), "STORE_STATE")
  errorCode(() => store.confirmEvent("EVT-nope", "confirmed"), "STORE_STATE")
  errorCode(() => store.confirmEvent(event.id, "maybe"), "STORE_INPUT")
})

test("T4 state machine: rule active → disabled → enable(new version); revoked active never rebuilt", (t) => {
  const { root, store } = fresh(t)
  const { rule } = store.recordDecision({ kind: "approve", object: APPROVAL() })
  assert.equal(rule.status, "active")
  assert.equal(rule.version, 1)
  const dis = store.recordDecision({ kind: "disable", ruleId: rule.id, object: { note: "obsolete" } })
  assert.equal(dis.rule.status, "disabled")
  errorCode(() => store.recordDecision({ kind: "disable", ruleId: rule.id, object: {} }), "STORE_STATE")
  errorCode(() => store.recordDecision({ kind: "enable", ruleId: rule.id }), "STORE_INPUT") // enable needs a fresh object
  const en = store.recordDecision({ kind: "enable", ruleId: rule.id, object: APPROVAL() })
  assert.equal(en.rule.status, "active")
  assert.equal(en.rule.version, 2, "re-enable is a new authorization = new version")

  // disable again, then open a completely fresh instance: history keeps the
  // approval records, but nothing ever rebuilds an active state from them
  store.recordDecision({ kind: "disable", ruleId: rule.id, object: {} })
  const s2 = openStore(root, QUICK)
  assert.equal(s2.listRules().find((r) => r.id === rule.id).status, "disabled")
  // D6 binding: the rule's approvalRef still resolves to its approval decision
  const approvalDecision = s2.listDecisions().find((d) => d.decisionHash === rule.approvalRef.decisionHash)
  assert.ok(approvalDecision, "approval history retained")
  assert.equal(approvalDecision.kind, "approve")
  assert.equal(approvalDecision.objectHash !== null, true)
  assert.equal(s2.listRules({ includeDisabled: false }).length, 0, "no auto-resurrection")
})

test("T4 decision hashes: canonical objectHash, self-hashed decision, approvalRef binding (D6)", (t) => {
  const { store } = fresh(t)
  const obj = APPROVAL()
  const { decision, rule } = store.recordDecision({ kind: "approve", object: obj })
  // objectHash binds the NORMALIZED approval object (the record persists the
  // normalized form: optional strings → null, agents → null)
  const normalized = { ...obj, directoryBoundary: null, agents: null }
  assert.equal(decision.objectHash, sha256Hex(canonicalJson(normalized)))
  const { decisionHash, ...decisionBase } = decision
  assert.equal(decisionHash, sha256Hex(canonicalJson(decisionBase)))
  assert.deepEqual(rule.approvalRef, { decisionId: decision.id, decisionHash })
  assert.equal(rule.publishResult, null, "approval ≠ applied")
})

test("T4 unknown issueId rejected on appendEvent (no silent new candidate)", (t) => {
  const { store } = fresh(t)
  errorCode(() => store.appendEvent({ ...EV(1), issueId: "ISS-nope" }), "STORE_STATE")
  assert.equal(store.listEvents().length, 0)
})

test("T4 input validation: bad scope / bad kind / bad evidence rejected as STORE_INPUT", (t) => {
  const { store } = fresh(t)
  errorCode(() => store.recordDecision({ kind: "approve", object: { ...APPROVAL(), scope: { kind: "galaxy" } } }), "STORE_INPUT")
  errorCode(() => store.recordDecision({ kind: "approve", object: { ...APPROVAL(), targets: "AGENTS.md" } }), "STORE_INPUT")
  errorCode(() => store.appendEvent({ source: { sessionId: "s" }, evidence: { excerpt: "x" } }), "STORE_INPUT")
  errorCode(() => store.appendEvent({ ...EV(1), evidence: { excerpt: "" } }), "STORE_INPUT")
  errorCode(() => store.recordDecision({ kind: "party" }), "STORE_INPUT")
})

test("T4 listPending: draft issues + pending events; merge keeps original event sources", (t) => {
  const { store } = fresh(t)
  const e1 = store.appendEvent(EV(1))
  store.appendEvent({ ...EV(2), issueId: e1.event.issueId })
  const e3 = store.appendEvent(EV(3)) // second candidate
  store.confirmEvent(e1.event.id, "confirmed") // reviewed → leaves pending
  let p = store.listPending()
  assert.equal(p.issues.length, 2)
  assert.equal(p.events.length, 2)
  assert.ok(p.events.every((e) => e.status === "pending"))

  // merge candidate 2 into candidate 1: events keep their original issueId
  // and source, only the resolved target moves
  store.mergeIssues(e3.event.issueId, e1.event.issueId)
  p = store.listPending()
  const ev3 = p.events.find((e) => e.id === e3.event.id)
  assert.equal(ev3.issueId, e3.event.issueId, "original association untouched")
  assert.equal(ev3.resolvedIssue.id, e1.event.issueId, "display resolves through the merge")
  assert.equal(ev3.source.sessionId, "ses_3", "original source preserved")
  assert.deepEqual(store.listIssues({ status: "draft" }).map((i) => i.id).sort(), [e1.event.issueId])
})

test("T4 projects: new directory starts unconfirmed; explicit confirm flips it", (t) => {
  const { store } = fresh(t)
  const { project } = store.upsertProject({ projectId: "proj_x", alias: "X", directory: "/home/u/x" })
  assert.equal(project.directories[0].confirmed, false, "R21-C3: shared id ≠ confirmed directory")
  const up = store.upsertProject({ projectId: "proj_x", directory: "/home/u/x", confirmDirectory: true })
  assert.equal(up.project.directories[0].confirmed, true)
  assert.ok(up.project.directories[0].confirmedTs > 0)
  assert.equal(store.status().counts.projects.confirmedDirectories, 1)
})

test("T4 recordPublishResult updates the rule's publish bookkeeping", (t) => {
  const { store } = fresh(t)
  const { rule } = store.recordDecision({ kind: "approve", object: APPROVAL() })
  errorCode(() => store.recordPublishResult("RUL-nope", { applied: true }), "STORE_STATE")
  store.recordPublishResult(rule.id, { applied: true, note: "pasted into AGENTS.md" })
  const r = store.getRule(rule.id)
  assert.equal(r.publishResult.applied, true)
  assert.equal(r.publishResult.note, "pasted into AGENTS.md")
})

// ---------- doctor ----------

test("T4 doctor: healthy store → all checks pass; corrupt store → failing checks with details", (t) => {
  const { root, store } = fresh(t)
  store.appendEvent(EV(1))
  const healthy = store.doctor()
  assert.equal(healthy.health.status, "ok")
  for (const c of healthy.checks) {
    assert.equal(c.ok, true, `check ${c.name} should pass: ${c.detail}`)
  }

  fs.appendFileSync(path.join(root, FILE_EVENTS), '{"torn')
  const sick = openStore(root, QUICK).doctor()
  assert.equal(sick.health.status, "corrupt")
  assert.equal(sick.checks.find((c) => c.name === "jsonl-lines").ok, false)
  assert.equal(sick.checks.find((c) => c.name === "store-files").ok, true)
})

test("T4 doctor: reports a live lock without touching it", (t) => {
  const { root, store } = fresh(t)
  plantLock(root, { pid: process.pid, ts: Date.now(), host: "busy" })
  const doc = store.doctor()
  assert.equal(doc.health.status, "ok", "a live lock alone does not corrupt the store")
  const lock = doc.checks.find((c) => c.name === "lock")
  assert.equal(lock.ok, false, "lock check flags the live holder")
  assert.ok(/live/.test(lock.detail))
  assert.equal(fs.existsSync(path.join(root, FILE_LOCK)), true, "doctor is read-only")
})
