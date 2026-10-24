// Unified supervisor-memory store — M1 plan §3 P1 (decision D5), design v5.0 II.1.
//
// Layout (single store under one root, no per-project partitioning):
//   <root>/rules.json        current rules (active/disabled), scope, approval refs
//   <root>/issues.json       candidate issues + human triage state
//   <root>/events.jsonl      sourced correction events (append-only log)
//   <root>/decisions.jsonl   approve/reject/disable/enable records (append-only)
//   <root>/projects.json     host project ids, aliases, confirmed directories
//   <root>/digest/           rebuildable views (pure view; written by P3, not here)
//   <root>/commit.marker     last transaction descriptor (phase pending|committed)
//   <root>/lock              whole-store exclusive lock (single writer at a time)
//
// Locking (D5): one exclusive lock per store guards every state change. Both
// runtimes that share this module (Bun plugin host, node>=20 CLI and tests)
// support O_EXCL create via fs.openSync(..., "wx"); flock(2) has no portable
// binding without native addons, and a lock *file* deliberately survives a
// killed process, which is exactly what stale recovery needs. Lock content is
// { pid, ts, host }. Recovery: (a) the recorded pid is provably dead
// (kill(pid, 0) → ESRCH) past a small grace window, or (b) the heartbeat ts is
// older than staleLockMs — covers a wedged-but-alive holder. A live, fresh
// lock is refused with STORE_LOCKED: concurrent OpenCode instances fail their
// write and never overwrite (D5 #7). No external dependencies.
//
// Commit protocol (D5 #1/#2): every state change runs as a transaction with a
// fixed step order — commit.marker rewritten as "pending" (listing each state
// file with its expected sha256) → decisions.jsonl first → the other involved
// state files → commit.marker rewritten as "committed". Each op's checklist
// lives in TXN_CHECKLISTS (single source of truth for the runner and for the
// T4 crash-injection matrix). open()/doctor() detect an unfinished
// transaction — "marker without content" and "content without marker" both
// surface as a pending marker whose diff shows landed vs not-landed files —
// and then health.status = "incomplete_commit": authorization outputs must be
// closed (no publish, no cleanup, no patch generation) and every mutation
// throws STORE_INCOMPLETE until a human resolves it. Corruption, permission
// errors, lock failures and unknown schema close the store too ("corrupt" /
// "permission"): never re-root elsewhere, never restore old approvals, never
// synthesize cleanup patches (D5 #4). A missing store is NOT a fresh install:
// only initStore() creates one (dir 0700 / files 0600 / empty skeleton +
// committed marker); openStore() refuses otherwise (D5 #5). Revoked active
// state is never rebuilt from old approval records: rules.json is the only
// current-state authority, decisions.jsonl is history (D5 #8). No rebuild in
// v1 — recovery is restoring a backup of this whole directory (see README).
//
// Sensitivity: events.jsonl stores short correction excerpts. Treat the whole
// directory as sensitive and back it up as one unit.
//
// Concurrency note: reads take the same exclusive lock briefly (the store is
// small), so a reader never sees a half-applied transaction. doctor() is the
// one deliberate exception: it reads lock-free so it can diagnose a store
// whose lock was leaked by a killed process.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"

export const SCHEMA_ID = "opencode-supervisor-memory"
export const SCHEMA_VERSION = 1

export const FILE_RULES = "rules.json"
export const FILE_ISSUES = "issues.json"
export const FILE_EVENTS = "events.jsonl"
export const FILE_DECISIONS = "decisions.jsonl"
export const FILE_PROJECTS = "projects.json"
export const FILE_MARKER = "commit.marker"
export const FILE_LOCK = "lock"
export const DIR_DIGEST = "digest"

// Record types that may legally appear in the .jsonl logs; anything else is an
// unknown schema (D5 #4) → fail closed, never silently skipped.
const KNOWN_RECORD_TYPES = new Set(["event", "event-status", "decision"])

const JSON_FILES = [FILE_RULES, FILE_ISSUES, FILE_PROJECTS]
const JSONL_FILES = [FILE_EVENTS, FILE_DECISIONS]
const STORE_FILES = [...JSON_FILES, ...JSONL_FILES]

export const DEFAULT_STALE_LOCK_MS = 30_000
export const DEFAULT_LOCK_TIMEOUT_MS = 1_000
export const DEFAULT_LOCK_POLL_MS = 25
export const DEFAULT_PID_GRACE_MS = 250
export const EVIDENCE_MAX_CHARS = 2000
export const TITLE_MAX_CHARS = 200

// D5 #2: transaction manifest. Ordered steps per operation; the txn runner
// executes exactly these steps and T4 injects a crash after each one.
// "decisions:append" always precedes any rules.json replacement (D5 order:
// decisions.jsonl → rules.json/issues.json → commit marker).
// appendEvent touches issues.json because a report either creates a candidate
// issue or bumps recurrence on an existing one (cross-file change, D5 v1.1).
export const TXN_CHECKLISTS = {
  appendEvent: ["marker:pending", "events:append", "issues:replace", "marker:commit"],
  confirmEvent: ["marker:pending", "events:append", "marker:commit"],
  upsertIssue: ["marker:pending", "issues:replace", "marker:commit"],
  recordDecisionApprove: ["marker:pending", "decisions:append", "rules:replace", "marker:commit"],
  recordDecisionReject: ["marker:pending", "decisions:append", "marker:commit"],
  recordDecisionDisable: ["marker:pending", "decisions:append", "rules:replace", "marker:commit"],
  recordDecisionEnable: ["marker:pending", "decisions:append", "rules:replace", "marker:commit"],
  // v6.2 system-ride delivery authorization (§III.8): history-only records —
  // the delivery state is DERIVED from the decision log (latest decision per
  // rule wins; a delivery-enable binds ruleId+version+bodyHash+channel, so a
  // re-approve to a new version auto-invalidates it). rules.json is never
  // touched by delivery decisions.
  recordDecisionDeliveryEnable: ["marker:pending", "decisions:append", "marker:commit"],
  recordDecisionDeliveryDisable: ["marker:pending", "decisions:append", "marker:commit"],
  recordPublishResult: ["marker:pending", "rules:replace", "marker:commit"],
  upsertProject: ["marker:pending", "projects:replace", "marker:commit"],
}

export class StoreError extends Error {
  /**
   * @param {string} code one of STORE_MISSING | STORE_EXISTS | STORE_CORRUPT |
   *   STORE_SCHEMA | STORE_LOCKED | STORE_PERM | STORE_INCOMPLETE | STORE_STATE | STORE_INPUT
   * @param {string} message
   * @param {*} [details]
   */
  constructor(code, message, details) {
    super(message)
    this.name = "StoreError"
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** Thrown only by the test fault hook after a transaction step (simulates kill). */
export class FaultInjected extends Error {
  constructor(op, step) {
    super(`fault injected after step "${step}" of ${op}`)
    this.name = "FaultInjected"
    this.op = op
    this.step = step
  }
}

/** Unified root for the memory store (override via initStore/openStore args in tests). */
export function defaultMemoryRoot() {
  return path.join(os.homedir(), ".local/share/opencode-supervisor/memory")
}

// ---------- small utils ----------

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function oct(m) {
  return "0" + m.toString(8)
}

function rand4() {
  return randomBytes(4).toString("hex")
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${rand4()}`
}

/** Deterministic JSON (sorted keys) — basis for approval-object / decision hashes (D6). */
export function canonicalJson(value) {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}"
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex")
}

function sleepSync(ms) {
  if (!(ms > 0)) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    return
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* bounded busy wait fallback */ }
  }
}

function posInt(v, fallback) {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function normalizeOpts(opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  const fault = o._fault && typeof o._fault === "object" ? o._fault : null
  return {
    staleLockMs: posInt(o.staleLockMs, DEFAULT_STALE_LOCK_MS),
    lockTimeoutMs: posInt(o.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS),
    lockPollMs: posInt(o.lockPollMs, DEFAULT_LOCK_POLL_MS),
    pidGraceMs: posInt(o.pidGraceMs, DEFAULT_PID_GRACE_MS),
    // Test-only fault hook: crashAfter = step name (see TXN_CHECKLISTS),
    // lockPid = pid recorded in the lock file (simulate a killed holder).
    _fault: fault
      ? {
          crashAfter: typeof fault.crashAfter === "string" ? fault.crashAfter : null,
          lockPid: Number.isInteger(fault.lockPid) ? fault.lockPid : null,
        }
      : null,
  }
}

// ---------- input validation (defensive, host-validated semantics trusted) ----------

function reqObject(v, name) {
  if (!isObj(v)) throw new StoreError("STORE_INPUT", `${name} must be an object`)
  return v
}

function reqString(v, name, max = Infinity) {
  if (typeof v !== "string" || v.length === 0) {
    throw new StoreError("STORE_INPUT", `${name} must be a non-empty string`)
  }
  return max < Infinity && v.length > max ? v.slice(0, max) : v
}

function optString(v, name, max = Infinity) {
  if (v === undefined || v === null) return null
  if (typeof v !== "string") throw new StoreError("STORE_INPUT", `${name} must be a string when provided`)
  return max < Infinity && v.length > max ? v.slice(0, max) : v
}

function normalizeClassification(c) {
  if (c === undefined || c === null) return null
  const o = reqObject(c, "classification")
  const kind = reqString(o.kind, "classification.kind", 32)
  if (kind !== "preference" && kind !== "capability") {
    throw new StoreError("STORE_INPUT", 'classification.kind must be "preference" or "capability"')
  }
  const layer = optString(o.layer, "classification.layer", 16)
  if (layer !== null && layer !== "global" && layer !== "project") {
    throw new StoreError("STORE_INPUT", 'classification.layer must be "global" or "project"')
  }
  const model = optString(o.model, "classification.model", 128)
  return { kind, layer, model }
}

function normalizeEventInput(input) {
  const i = reqObject(input, "input")
  const source = reqObject(i.source, "input.source")
  const sessionId = reqString(source.sessionId, "input.source.sessionId", 256)
  const projectId = reqString(source.projectId, "input.source.projectId", 512)
  const messageId = reqString(source.messageId, "input.source.messageId", 256)
  const evidence = reqObject(i.evidence, "input.evidence")
  const excerpt = reqString(evidence.excerpt, "input.evidence.excerpt", EVIDENCE_MAX_CHARS)
  const messageRef = optString(evidence.messageRef, "input.evidence.messageRef", 256)
  const evidenceTs =
    typeof evidence.ts === "number" && Number.isFinite(evidence.ts) ? evidence.ts : null
  const issueId =
    i.issueId === undefined || i.issueId === null ? null : reqString(i.issueId, "input.issueId", 128)
  const title = optString(i.title, "input.title", TITLE_MAX_CHARS)
  const topic = optString(i.topic, "input.topic", 100)
  const classification = normalizeClassification(i.classification)
  // Idempotency key (II.1): same source message → same event, never a second one.
  const sourceKey = sha256Hex(canonicalJson({ sessionId, messageId })).slice(0, 32)
  return { sessionId, projectId, messageId, excerpt, messageRef, evidenceTs, issueId, title, topic, classification, sourceKey }
}

function normalizeScope(scope) {
  const s = reqObject(scope, "object.scope")
  const kind = reqString(s.kind, "object.scope.kind", 32)
  if (kind !== "project" && kind !== "user-global" && kind !== "directory") {
    throw new StoreError("STORE_INPUT", 'object.scope.kind must be "project" | "user-global" | "directory"')
  }
  if (kind === "project") reqString(s.projectId, "object.scope.projectId", 512)
  if (kind === "directory") {
    const d = reqString(s.directory, "object.scope.directory", 1024)
    if (!path.isAbsolute(d)) throw new StoreError("STORE_INPUT", "object.scope.directory must be an absolute path")
  }
  return s
}

/** Full approval object shown to the user and confirmed at the CLI (D6 display-confirm binding). */
function normalizeApprovalObject(obj) {
  const o = reqObject(obj, "object")
  const body = reqString(o.body, "object.body", 8000)
  const scope = normalizeScope(o.scope)
  if (!Array.isArray(o.targets)) {
    throw new StoreError("STORE_INPUT", "object.targets must be an array of target file paths")
  }
  const targets = o.targets.map((t, ix) => reqString(t, `object.targets[${ix}]`, 1024))
  const reviewDate = optString(o.reviewDate, "object.reviewDate", 64)
  const channel = optString(o.channel, "object.channel", 64)
  const directoryBoundary = optString(o.directoryBoundary, "object.directoryBoundary", 1024)
  let agents = null
  if (o.agents !== undefined && o.agents !== null) {
    if (!Array.isArray(o.agents)) throw new StoreError("STORE_INPUT", "object.agents must be an array")
    agents = o.agents.map((a, ix) => reqString(a, `object.agents[${ix}]`, 128))
  }
  return { body, scope, targets, reviewDate, channel, directoryBoundary, agents }
}

// ---------- locking ----------

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "ESRCH" ? false : true // EPERM → treat as alive
  }
}

/**
 * Classify the store lock. recoverable=true means the holder is provably gone
 * (dead pid past grace) or its heartbeat expired (stale); otherwise the lock
 * is live and writes must fail, never overwrite.
 */
function readLockInfo(lockPath, opts) {
  let mtimeMs = 0
  let text = null
  try {
    const st = fs.statSync(lockPath)
    mtimeMs = st.mtimeMs
    text = fs.readFileSync(lockPath, "utf8")
  } catch {
    return { exists: false, recoverable: false, state: "absent" }
  }
  const ageMs = Math.max(0, Date.now() - mtimeMs)
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const pid = parsed && Number.isInteger(parsed.pid) ? parsed.pid : null
  const ts = parsed && Number.isInteger(parsed.ts) ? parsed.ts : null
  const heartbeatAgeMs = ts !== null ? Math.max(0, Date.now() - ts) : null
  const alive = pid !== null ? pidAlive(pid) : null
  let state
  let recoverable
  if (parsed === null || pid === null) {
    state = ageMs > opts.staleLockMs ? "stale-unparsable" : "unknown"
    recoverable = state === "stale-unparsable"
  } else if (alive === false && ageMs > opts.pidGraceMs) {
    state = "dead-pid"
    recoverable = true
  } else if (heartbeatAgeMs !== null && heartbeatAgeMs > opts.staleLockMs) {
    state = "stale-heartbeat"
    recoverable = true
  } else if (heartbeatAgeMs === null && ageMs > opts.staleLockMs) {
    state = "stale-mtime"
    recoverable = true
  } else {
    state = alive === false ? "starting" : "live"
    recoverable = false
  }
  return { exists: true, recoverable, state, pid, ageMs, heartbeatAgeMs }
}

/** Acquire the whole-store lock; throws STORE_LOCKED (live holder) / STORE_PERM (cannot create). */
function acquireLock(root, opts) {
  const lockPath = path.join(root, FILE_LOCK)
  const deadline = Date.now() + opts.lockTimeoutMs
  for (;;) {
    let fd
    try {
      fd = fs.openSync(lockPath, "wx", 0o600)
    } catch (e) {
      if (e.code !== "EEXIST") {
        throw new StoreError("STORE_PERM", `cannot create lock file: ${e.code}`, { lockPath, errno: e.code })
      }
      const info = readLockInfo(lockPath, opts)
      if (info.recoverable) {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* someone else recovered it; loop retries */
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new StoreError(
          "STORE_LOCKED",
          `store is locked by ${info.state === "live" ? `a live process (pid ${info.pid})` : `an unresolved lock (${info.state})`}; write failed without overwriting`,
          info,
        )
      }
      sleepSync(opts.lockPollMs)
      continue
    }
    try {
      const payload = JSON.stringify({
        pid: opts._fault && opts._fault.lockPid !== null ? opts._fault.lockPid : process.pid,
        ts: Date.now(),
        host: os.hostname(),
      })
      fs.writeSync(fd, payload)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    let released = false
    return {
      release() {
        if (released) return
        released = true
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* already gone */
        }
      },
    }
  }
}

// ---------- file primitives ----------

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${rand4()}`)
  const fd = fs.openSync(tmp, "wx", 0o600)
  try {
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, filePath)
  fs.chmodSync(filePath, 0o600)
}

function appendLine(filePath, line) {
  if (!isFile(filePath)) {
    throw new StoreError("STORE_CORRUPT", `append target missing: ${path.basename(filePath)}`)
  }
  fs.appendFileSync(filePath, line)
}

function serializeDoc(doc, ctx) {
  const out = { ...doc, lastTxn: { txnId: ctx.txnId, seq: ctx.seq, op: ctx.op, ts: ctx.ts } }
  return JSON.stringify(out, null, 2) + "\n"
}

function writeMarker(root, marker) {
  writeFileAtomic(path.join(root, FILE_MARKER), JSON.stringify(marker, null, 2) + "\n")
}

// ---------- health evaluation (read-only core; used by open/read/write/doctor) ----------

function foldEvents(records) {
  const byId = new Map()
  for (const r of records) {
    if (r.type === "event") byId.set(r.id, { ...r, status: "pending" })
    else if (r.type === "event-status") {
      const e = byId.get(r.eventId)
      if (e) e.status = r.status
    }
  }
  return [...byId.values()]
}

function computeCounts(data) {
  const rules = Object.values(data.rulesDoc?.rules ?? {})
  const issues = Object.values(data.issuesDoc?.issues ?? {})
  const events = foldEvents(data.events ?? [])
  const decisions = data.decisions ?? []
  const projects = Object.values(data.projectsDoc?.projects ?? {})
  const by = (arr, key) =>
    arr.reduce((m, r) => {
      m[r[key]] = (m[r[key]] ?? 0) + 1
      return m
    }, {})
  return {
    rules: by(rules, "status"),
    issues: by(issues, "status"),
    events: by(events, "status"),
    decisions: by(decisions, "kind"),
    projects: {
      total: projects.length,
      confirmedDirectories: projects.reduce(
        (n, p) => n + (p.directories ?? []).filter((d) => d.confirmed).length,
        0,
      ),
    },
  }
}

function describeIncomplete(inc) {
  if (!inc) return "incomplete commit (no details)"
  const landed = inc.files.filter((f) => f.landed).map((f) => f.path)
  const missing = inc.files.filter((f) => !f.landed).map((f) => f.path)
  return (
    `incomplete commit ${inc.txnId} (${inc.op}): ${inc.summary || "no summary"} — ` +
    `landed: [${landed.join(", ") || "none"}], missing: [${missing.join(", ") || "none"}]; ` +
    `authorization outputs are closed; restore this directory from backup or resolve manually (no rebuild in v1)`
  )
}

/**
 * Read-only full-store evaluation. Never throws for damaged stores — damage
 * is reported via status/problems so doctor() can describe it. Mutators and
 * authorization-relevant reads gate on the returned status.
 */
function evaluateHealth(root, opts = {}) {
  const problems = []
  const h = { status: "ok", problems, incomplete: null, lockInfo: null, marker: null, data: null, counts: {} }
  let st
  try {
    st = fs.statSync(root)
  } catch {
    h.status = "missing"
    return h
  }
  if (!st.isDirectory()) {
    h.status = "missing"
    return h
  }
  const dirMode = st.mode & 0o777
  if ((dirMode & 0o077) !== 0) {
    problems.push({
      check: "permissions",
      severity: "permission",
      detail: `store directory mode ${oct(dirMode)} is too permissive (want 0700)`,
    })
  }

  const existing = {}
  const missing = []
  for (const f of STORE_FILES) {
    if (isFile(path.join(root, f))) existing[f] = true
    else missing.push(f)
  }
  const markerExists = isFile(path.join(root, FILE_MARKER))
  if (!markerExists && missing.length === STORE_FILES.length) {
    h.status = "missing"
    return h
  }
  if (missing.length > 0) {
    problems.push({ check: "files-present", severity: "corrupt", detail: `missing store files: ${missing.join(", ")}` })
  }
  if (!markerExists) {
    problems.push({
      check: "commit-marker",
      severity: "corrupt",
      detail: "commit.marker is missing while store content exists (content without commit marker)",
    })
  }

  h.lockInfo = readLockInfo(path.join(root, FILE_LOCK), opts)

  let marker = null
  if (markerExists) {
    try {
      marker = JSON.parse(fs.readFileSync(path.join(root, FILE_MARKER), "utf8"))
      if (marker.schema !== SCHEMA_ID || marker.version !== SCHEMA_VERSION) {
        problems.push({
          check: "commit-marker",
          severity: "corrupt",
          detail: `unknown commit marker schema ${JSON.stringify(marker.schema)}/${JSON.stringify(marker.version)}`,
        })
      } else if (marker.phase !== "pending" && marker.phase !== "committed") {
        problems.push({ check: "commit-marker", severity: "corrupt", detail: `unknown marker phase ${JSON.stringify(marker.phase)}` })
      }
    } catch (e) {
      problems.push({ check: "commit-marker", severity: "corrupt", detail: `commit.marker unparsable: ${e.message}` })
    }
  }
  h.marker = marker
  // Content ceiling: any record/envelope seq at or below the marker's own seq
  // is accounted for — a committed marker's seq is the last committed txn, and
  // a PENDING marker's seq covers the in-flight txn's partially-written content
  // (its landed/unlanded files are reconciled by the incomplete-commit check
  // below, not here). Only content strictly newer than the marker seq has no
  // marker coverage at all → corrupt (D5 #3/#4).
  const ceilingSeq = marker && Number.isInteger(marker.seq) ? marker.seq : 0

  // JSON state files: presence/parse/schema/seq checks.
  const docs = {}
  for (const f of JSON_FILES) {
    if (!existing[f]) continue
    let text
    try {
      text = fs.readFileSync(path.join(root, f), "utf8")
    } catch (e) {
      problems.push({
        check: f,
        severity: e.code === "EACCES" ? "permission" : "corrupt",
        detail: `cannot read ${f}: ${e.message}`,
      })
      continue
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch (e) {
      problems.push({ check: f, severity: "corrupt", detail: `${f} unparsable (truncated?): ${e.message}` })
      continue
    }
    if (doc.schema !== SCHEMA_ID || doc.version !== SCHEMA_VERSION) {
      problems.push({
        check: "schema",
        severity: "corrupt",
        detail: `${f} has unknown schema ${JSON.stringify(doc.schema)}/${JSON.stringify(doc.version)} (want ${SCHEMA_ID}/${SCHEMA_VERSION})`,
      })
      continue
    }
    const last = doc.lastTxn
    if (last !== null && last !== undefined && (!isObj(last) || typeof last.txnId !== "string" || !Number.isInteger(last.seq))) {
      problems.push({ check: f, severity: "corrupt", detail: `${f} has a malformed lastTxn envelope` })
      continue
    }
    if (last !== null && last !== undefined && last.seq > ceilingSeq) {
      problems.push({
        check: "state-vs-marker",
        severity: "corrupt",
        detail: `${f} contains transaction ${last.txnId} (seq ${last.seq}) newer than the last commit marker (seq ${ceilingSeq}) — content without commit marker`,
      })
    }
    docs[f] = doc
  }

  // JSONL logs: parse every line; a torn trailing line = truncation → corrupt.
  const raws = {}
  const lines = {}
  for (const f of JSONL_FILES) {
    if (!existing[f]) continue
    let text
    try {
      text = fs.readFileSync(path.join(root, f), "utf8")
    } catch (e) {
      problems.push({
        check: f,
        severity: e.code === "EACCES" ? "permission" : "corrupt",
        detail: `cannot read ${f}: ${e.message}`,
      })
      continue
    }
    raws[f] = text
    const recs = []
    const ls = text.split("\n")
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i]
      if (line === "") {
        if (i === ls.length - 1) continue
        problems.push({ check: f, severity: "corrupt", detail: `${f} line ${i + 1}: unexpected empty line` })
        continue
      }
      let rec
      try {
        rec = JSON.parse(line)
      } catch (e) {
        problems.push({ check: f, severity: "corrupt", detail: `${f} line ${i + 1} unparsable (truncated?): ${e.message}` })
        continue
      }
      if (
        !isObj(rec) ||
        typeof rec.type !== "string" ||
        !KNOWN_RECORD_TYPES.has(rec.type) ||
        rec.v !== SCHEMA_VERSION ||
        !Number.isInteger(rec.seq) ||
        typeof rec.txnId !== "string"
      ) {
        problems.push({ check: "schema", severity: "corrupt", detail: `${f} line ${i + 1}: unknown record schema` })
        continue
      }
      if (rec.seq > ceilingSeq) {
        problems.push({
          check: "state-vs-marker",
          severity: "corrupt",
          detail: `${f} line ${i + 1} carries transaction ${rec.txnId} (seq ${rec.seq}) newer than the last commit marker (seq ${ceilingSeq}) — content without commit marker`,
        })
      }
      recs.push(rec)
    }
    lines[f] = recs
  }

  // Per-file permission check (excerpts are sensitive → 0600 hard requirement).
  for (const f of [...STORE_FILES, FILE_MARKER]) {
    if (f === FILE_MARKER && !markerExists) continue
    if (f !== FILE_MARKER && !existing[f]) continue
    let mode
    try {
      mode = fs.statSync(path.join(root, f)).mode & 0o777
    } catch {
      continue
    }
    if ((mode & 0o077) !== 0) {
      problems.push({ check: "permissions", severity: "permission", detail: `${f} mode ${oct(mode)} is too permissive (want 0600)` })
    }
  }

  if (!fs.existsSync(path.join(root, DIR_DIGEST))) {
    problems.push({ check: "digest-dir", severity: "warn", detail: "digest/ view directory is missing (rebuildable, non-fatal)" })
  }

  // Incomplete-commit diff: pending marker vs actual file hashes.
  if (marker && marker.phase === "pending") {
    const files = Array.isArray(marker.files)
      ? marker.files.map((e) => {
          const p = path.join(root, e?.path ?? "")
          let actual = null
          try {
            actual = sha256Hex(fs.readFileSync(p, "utf8"))
          } catch {
            actual = null
          }
          const expected = e?.expect?.sha256 ?? null
          return {
            path: e?.path ?? "?",
            kind: e?.expect?.kind ?? null,
            landed: actual !== null && expected !== null && actual === expected,
            expectedSha256: expected,
            actualSha256: actual,
          }
        })
      : []
    h.incomplete = {
      txnId: marker.txnId ?? "?",
      seq: marker.seq ?? 0,
      op: marker.op ?? "?",
      summary: marker.summary ?? "",
      startedTs: marker.startedTs ?? null,
      steps: Array.isArray(marker.steps) ? marker.steps : [],
      files,
    }
  }

  const hasSeverity = (s) => problems.some((p) => p.severity === s)
  if (hasSeverity("corrupt")) h.status = "corrupt"
  else if (marker && marker.phase === "pending") h.status = "incomplete_commit"
  else if (hasSeverity("permission")) h.status = "permission"
  else h.status = "ok"

  h.data = {
    rulesDoc: docs[FILE_RULES] ?? null,
    issuesDoc: docs[FILE_ISSUES] ?? null,
    projectsDoc: docs[FILE_PROJECTS] ?? null,
    raw: { [FILE_EVENTS]: raws[FILE_EVENTS] ?? "", [FILE_DECISIONS]: raws[FILE_DECISIONS] ?? "" },
    [FILE_EVENTS]: lines[FILE_EVENTS] ?? [],
    [FILE_DECISIONS]: lines[FILE_DECISIONS] ?? [],
  }
  h.counts = computeCounts(h.data)
  return h
}

// ---------- Store ----------

export class Store {
  /** @internal use openStore() */
  constructor(root, opts, health) {
    this.root = root
    this.opts = opts
    /** @type {{status: string, problems: Array, incomplete: object|null}} */
    this.health = { status: health.status, problems: health.problems, incomplete: health.incomplete }
  }

  #refresh() {
    const h = evaluateHealth(this.root, this.opts)
    this.health = { status: h.status, problems: h.problems, incomplete: h.incomplete }
    return h
  }

  #assertWritable(h) {
    if (h.status === "ok") return
    if (h.status === "incomplete_commit") {
      throw new StoreError("STORE_INCOMPLETE", describeIncomplete(h.incomplete), h.incomplete)
    }
    if (h.status === "missing") {
      throw new StoreError("STORE_MISSING", "memory store is missing (a missing store is not a fresh install; run init explicitly)")
    }
    if (h.status === "permission") {
      const perms = h.problems.filter((p) => p.severity === "permission").map((p) => p.detail)
      throw new StoreError("STORE_PERM", `store has permission problems: ${perms.join("; ")}`, { problems: perms })
    }
    const details = h.problems.map((p) => p.detail).join("; ")
    throw new StoreError("STORE_CORRUPT", `store is damaged, failing closed: ${details}`, { problems: h.problems })
  }

  #gateRead(h) {
    if (h.status === "ok" || h.status === "incomplete_commit") return h
    this.#assertWritable(h)
  }

  // Reads take the whole-store lock briefly so a reader never observes a
  // half-applied transaction. Reads are allowed on incomplete_commit (the
  // diff report must stay visible to humans) but never on corrupt stores.
  #read(fn) {
    const lock = acquireLock(this.root, this.opts)
    try {
      const h = this.#refresh()
      this.#gateRead(h)
      return fn(h)
    } finally {
      lock.release()
    }
  }

  /**
   * Strict gate for authorization outputs (D5 #3): throws unless health is
   * exactly "ok". P2 tools / P3 CLI call this before any publish/patch/
   * cleanup decision; returns the fresh health object otherwise.
   */
  requireHealthy() {
    const h = this.#refresh()
    this.#assertWritable(h)
    return { status: h.status, problems: h.problems, incomplete: h.incomplete, counts: h.counts }
  }

  /**
   * Read-only diagnostics (P1 doctor): integrity, schema, lock, incomplete
   * commits, permissions. Lock-free by design so it also works when a killed
   * process left the lock behind.
   */
  doctor() {
    const h = evaluateHealth(this.root, this.opts)
    this.health = { status: h.status, problems: h.problems, incomplete: h.incomplete }
    const failing = new Set(h.problems.filter((p) => p.severity !== "warn").map((p) => p.check))
    const checks = [
      {
        name: "store-files",
        ok: !failing.has("files-present") && h.status !== "missing",
        detail: h.problems.find((p) => p.check === "files-present")?.detail ?? "rules/issues/events/decisions/projects present",
      },
      {
        name: "schema",
        ok: !failing.has("schema"),
        detail: h.problems.find((p) => p.check === "schema")?.detail ?? `${SCHEMA_ID}/${SCHEMA_VERSION}`,
      },
      {
        name: "jsonl-lines",
        ok: !h.problems.some((p) => p.severity === "corrupt" && /line \d+/.test(p.detail)),
        detail: h.problems.find((p) => /line \d+/.test(p.detail))?.detail ?? "all jsonl lines parse",
      },
      {
        name: "commit-marker",
        ok: !failing.has("commit-marker") && h.status !== "incomplete_commit",
        detail:
          h.status === "incomplete_commit"
            ? describeIncomplete(h.incomplete)
            : h.problems.find((p) => p.check === "commit-marker")?.detail ??
              (h.marker ? `last commit ${h.marker.txnId} (${h.marker.op}, phase ${h.marker.phase})` : "no marker"),
      },
      {
        name: "state-vs-marker",
        ok: !failing.has("state-vs-marker"),
        detail: h.problems.find((p) => p.check === "state-vs-marker")?.detail ?? "no content ahead of the commit marker",
      },
      {
        name: "permissions",
        ok: !failing.has("permissions"),
        detail: h.problems.find((p) => p.check === "permissions")?.detail ?? "dir 0700 / files 0600",
      },
      {
        name: "lock",
        ok: !h.lockInfo?.exists || h.lockInfo.recoverable,
        detail: h.lockInfo?.exists
          ? `lock present (${h.lockInfo.state}${h.lockInfo.pid !== null ? `, pid ${h.lockInfo.pid}` : ""}, age ${h.lockInfo.ageMs}ms)${h.lockInfo.recoverable ? " — will be recovered on next write" : " — live holder refuses writes"}`
          : "no lock held",
      },
      {
        name: "digest-dir",
        ok: !h.problems.some((p) => p.check === "digest-dir"),
        detail: h.problems.find((p) => p.check === "digest-dir")?.detail ?? "digest/ present",
      },
    ]
    return {
      root: this.root,
      health: { status: h.status, problems: h.problems },
      incomplete: h.incomplete,
      lock: h.lockInfo,
      counts: h.counts,
      checks,
    }
  }

  /** Status query (CLI `status`): health snapshot + object counts. */
  status() {
    return this.#read((h) => ({
      root: this.root,
      health: { status: h.status, problems: h.problems },
      incomplete: h.incomplete,
      lock: h.lockInfo,
      counts: h.counts,
    }))
  }

  // ---------- read models (D9 read-only check data access) ----------

  /**
   * All current rules, including disabled ones — the D9 read-only check needs
   * body/scope/targets/status for presence/absence comparison. For old
   * versions and disabled bodies beyond the current record, pair this with
   * listDecisions() (each decision carries the full approved object).
   */
  listRules(opts = {}) {
    const includeDisabled = opts.includeDisabled !== false
    return this.#read((h) =>
      Object.values(h.data.rulesDoc?.rules ?? {}).filter((r) => includeDisabled || r.status === "active"),
    )
  }

  /** One rule by id, or null. */
  getRule(id) {
    const rid = reqString(id, "ruleId", 128)
    return this.#read((h) => h.data.rulesDoc?.rules?.[rid] ?? null)
  }

  /** One issue (candidate) by id, or null. */
  getIssue(id) {
    const iid = reqString(id, "issueId", 128)
    return this.#read((h) => h.data.issuesDoc?.issues?.[iid] ?? null)
  }

  /** Decision history (approve/reject/disable/enable), newest last; filterable. */
  listDecisions(filter = {}) {
    return this.#read((h) =>
      (h.data[FILE_DECISIONS] ?? []).filter(
        (d) =>
          d.type === "decision" &&
          (filter.ruleId === undefined || d.ruleId === filter.ruleId) &&
          (filter.kind === undefined || d.kind === filter.kind),
      ),
    )
  }

  /** Events folded to their current review status (pending → confirmed/false_positive). */
  listEvents(filter = {}) {
    return this.#read((h) =>
      foldEvents(h.data[FILE_EVENTS] ?? []).filter(
        (e) =>
          (filter.issueId === undefined || e.issueId === filter.issueId) &&
          (filter.status === undefined || e.status === filter.status),
      ),
    )
  }

  /** Issues (candidates) with their triage state; filterable by status. */
  listIssues(filter = {}) {
    return this.#read((h) =>
      Object.values(h.data.issuesDoc?.issues ?? {}).filter(
        (i) => filter.status === undefined || i.status === filter.status,
      ),
    )
  }

  /**
   * Digest view (D10): draft issues + events still awaiting human review.
   * Events keep their original issueId; a merged target is resolved via
   * `resolvedIssue` without touching the event's original source.
   */
  listPending() {
    return this.#read((h) => {
      const issues = h.data.issuesDoc?.issues ?? {}
      const resolve = (id) => {
        let cur = issues[id]
        let guard = 0
        while (cur && cur.mergedInto && issues[cur.mergedInto] && guard++ < 16) cur = issues[cur.mergedInto]
        return cur ?? null
      }
      const events = foldEvents(h.data[FILE_EVENTS] ?? [])
        .filter((e) => e.status === "pending")
        .map((e) => ({ ...e, resolvedIssue: resolve(e.issueId) }))
      return { issues: Object.values(issues).filter((i) => i.status === "draft"), events }
    })
  }

  /** Projects registry (host project ids, aliases, confirmed/unconfirmed directories). */
  listProjects() {
    return this.#read((h) => Object.values(h.data.projectsDoc?.projects ?? {}))
  }

  // ---------- transactions ----------

  /**
   * Run one D5 transaction: acquire the whole-store lock, re-verify health
   * under the lock (fail-closed), precompute every output file, then write
   * pending commit.marker → state files (decisions first) → committed marker.
   * An empty output set is a legitimate no-op (e.g. idempotent duplicate).
   * The _fault test hook can terminate the transaction after any step while
   * deliberately leaking the lock, simulating a killed process.
   */
  #write(op, build) {
    const steps = TXN_CHECKLISTS[op]
    if (!steps) throw new StoreError("STORE_INPUT", `unknown transaction op ${op}`)
    const lock = acquireLock(this.root, this.opts)
    let killed = false
    const fault = this.opts._fault
    const crashAfter = (step) => {
      if (fault && fault.crashAfter === step) {
        killed = true // leak the lock, like a killed process would
        throw new FaultInjected(op, step)
      }
    }
    try {
      const h = this.#refresh()
      this.#assertWritable(h)
      const ctx = {
        op,
        seq: (Number.isInteger(h.marker?.seq) ? h.marker.seq : 0) + 1,
        ts: Date.now(),
      }
      ctx.txnId = `txn-${ctx.seq}-${rand4()}`
      const built = build(h.data, ctx) ?? {}
      const outputs = built.outputs
      if (!outputs || outputs.size === 0) return built.result
      const stateSteps = steps.filter((s) => !s.startsWith("marker:"))
      for (const s of stateSteps) {
        if (!outputs.has(s)) throw new StoreError("STORE_INPUT", `internal: transaction ${op} missing output for step ${s}`)
      }
      for (const k of outputs.keys()) {
        if (!stateSteps.includes(k)) throw new StoreError("STORE_INPUT", `internal: transaction ${op} has stray output ${k}`)
      }
      const entries = stateSteps.map((s) => {
        const o = outputs.get(s)
        return { path: o.path, expect: { kind: o.kind, sha256: sha256Hex(o.content), bytes: Buffer.byteLength(o.content) } }
      })
      const summary = built.summary ?? op
      const base = {
        schema: SCHEMA_ID,
        version: SCHEMA_VERSION,
        txnId: ctx.txnId,
        seq: ctx.seq,
        prevSeq: Number.isInteger(h.marker?.seq) ? h.marker.seq : 0,
        op,
        summary,
        steps,
        startedTs: ctx.ts,
      }
      writeMarker(this.root, { ...base, phase: "pending", files: entries })
      crashAfter("marker:pending")
      for (const s of steps) {
        if (s.startsWith("marker:")) continue
        const o = outputs.get(s)
        if (o.kind === "append") appendLine(path.join(this.root, o.path), o.line)
        else writeFileAtomic(path.join(this.root, o.path), o.content)
        crashAfter(s)
      }
      writeMarker(this.root, { ...base, phase: "committed", files: entries, committedTs: Date.now() })
      crashAfter("marker:commit")
      return built.result
    } finally {
      if (!killed) lock.release()
    }
  }

  /**
   * Record one sourced correction event (the memory_record_correction write path).
   * Idempotent by source (sessionId + messageId): a duplicate returns
   * {duplicate:true} with the existing event and writes nothing. With
   * issueId: the issue must exist (unknown ids are rejected, never silently
   * ignored) and its recurrence is bumped. Without issueId: a new draft
   * candidate issue is created. The original source (session/project/message)
   * is stored on the event and never rewritten by later merges or scope
   * upgrades (II.1 evidence provenance).
   * @returns {{duplicate?: boolean, event: object, issue?: object}}
   */
  appendEvent(input) {
    const norm = normalizeEventInput(input)
    return this.#write("appendEvent", (data, ctx) => {
      const existing = (data[FILE_EVENTS] ?? []).find((r) => r.type === "event" && r.sourceKey === norm.sourceKey)
      if (existing) {
        const folded = foldEvents(data[FILE_EVENTS] ?? []).find((e) => e.id === existing.id) ?? { ...existing, status: "pending" }
        return { result: { duplicate: true, event: folded } }
      }
      const issuesDoc = data.issuesDoc
      if (!issuesDoc || !isObj(issuesDoc.issues)) {
        throw new StoreError("STORE_CORRUPT", "issues.json is missing or malformed")
      }
      const ts = ctx.ts
      const eventId = newId("EVT")
      let issueId = norm.issueId
      let issue
      if (issueId !== null) {
        issue = issuesDoc.issues[issueId]
        if (!issue) {
          throw new StoreError("STORE_STATE", `unknown issueId ${issueId}: candidates must exist and belong to the same project (D3/D4)`)
        }
        if (issue.status !== "draft") {
          throw new StoreError("STORE_STATE", `issue ${issueId} is ${issue.status}; only draft issues accept new events`)
        }
        issue.recurrence = (Number.isInteger(issue.recurrence) ? issue.recurrence : 0) + 1
        issue.lastEventAtTs = ts
        issue.evidenceIds = Array.isArray(issue.evidenceIds) ? [...issue.evidenceIds, eventId] : [eventId]
        issue.updatedAtTs = ts
      } else {
        issueId = newId("ISS")
        issue = {
          id: issueId,
          status: "draft",
          title: norm.title ?? norm.excerpt.slice(0, 80),
          topic: norm.topic,
          classification: norm.classification,
          projectId: norm.projectId,
          evidenceIds: [eventId],
          recurrence: 1,
          lastEventAtTs: ts,
          mergedInto: null,
          createdAtTs: ts,
          updatedAtTs: ts,
        }
        issuesDoc.issues[issueId] = issue
      }
      const event = {
        type: "event",
        v: SCHEMA_VERSION,
        id: eventId,
        txnId: ctx.txnId,
        seq: ctx.seq,
        ts,
        issueId,
        status: "pending",
        source: { sessionId: norm.sessionId, projectId: norm.projectId, messageId: norm.messageId },
        evidence: { excerpt: norm.excerpt, ts: norm.evidenceTs ?? ts, messageRef: norm.messageRef },
        sourceKey: norm.sourceKey,
      }
      const raw = data.raw[FILE_EVENTS] ?? ""
      const line = JSON.stringify(event) + "\n"
      return {
        summary: `event ${eventId} for issue ${issueId}${norm.issueId !== null ? " (recurrence)" : " (new candidate)"}`,
        outputs: new Map([
          ["events:append", { path: FILE_EVENTS, kind: "append", line, content: raw + line }],
          ["issues:replace", { path: FILE_ISSUES, kind: "replace", content: serializeDoc(issuesDoc, ctx) }],
        ]),
        result: { duplicate: false, event, issue },
      }
    })
  }

  /**
   * Human review outcome for one event (II.1 state machine: pending →
   * confirmed | false_positive; terminal — further changes are rejected, a
   * revoked judgement is never auto-flipped back).
   */
  confirmEvent(eventId, outcome) {
    const eid = reqString(eventId, "eventId", 128)
    if (outcome !== "confirmed" && outcome !== "false_positive") {
      throw new StoreError("STORE_INPUT", 'outcome must be "confirmed" or "false_positive"')
    }
    return this.#write("confirmEvent", (data, ctx) => {
      const events = foldEvents(data[FILE_EVENTS] ?? [])
      const ev = events.find((e) => e.id === eid)
      if (!ev) throw new StoreError("STORE_STATE", `unknown event ${eid}`)
      if (ev.status !== "pending") {
        throw new StoreError("STORE_STATE", `event ${eid} is already ${ev.status}; review outcomes are terminal`)
      }
      const record = {
        type: "event-status",
        v: SCHEMA_VERSION,
        id: newId("EVS"),
        txnId: ctx.txnId,
        seq: ctx.seq,
        ts: ctx.ts,
        eventId: eid,
        status: outcome,
        by: "user",
      }
      const raw = data.raw[FILE_EVENTS] ?? ""
      const line = JSON.stringify(record) + "\n"
      return {
        summary: `event ${eid} → ${outcome}`,
        outputs: new Map([["events:append", { path: FILE_EVENTS, kind: "append", line, content: raw + line }]]),
        result: { event: { ...ev, status: outcome } },
      }
    })
  }

  /**
   * Create or update a candidate issue (manual triage entry point).
   * Create: {title, topic?, classification?, projectId?} → status draft.
   * Update: {id, title?/topic?/classification?, status?} — state machine is
   * draft → approved | merged | dropped; merged requires mergedInto pointing
   * at an existing issue; terminal statuses reject further status changes.
   */
  upsertIssue(input) {
    const i = reqObject(input, "input")
    return this.#write("upsertIssue", (data, ctx) => {
      const issuesDoc = data.issuesDoc
      if (!issuesDoc || !isObj(issuesDoc.issues)) {
        throw new StoreError("STORE_CORRUPT", "issues.json is missing or malformed")
      }
      const ts = ctx.ts
      if (i.id === undefined || i.id === null) {
        if (i.status !== undefined && i.status !== "draft") {
          throw new StoreError("STORE_INPUT", "new issues always start as draft")
        }
        const title = reqString(i.title, "input.title", TITLE_MAX_CHARS)
        const issue = {
          id: newId("ISS"),
          status: "draft",
          title,
          topic: optString(i.topic, "input.topic", 100),
          classification: normalizeClassification(i.classification),
          projectId: optString(i.projectId, "input.projectId", 512),
          evidenceIds: [],
          recurrence: 0,
          lastEventAtTs: null,
          mergedInto: null,
          createdAtTs: ts,
          updatedAtTs: ts,
        }
        issuesDoc.issues[issue.id] = issue
        return {
          summary: `issue ${issue.id} created`,
          outputs: new Map([["issues:replace", { path: FILE_ISSUES, kind: "replace", content: serializeDoc(issuesDoc, ctx) }]]),
          result: { issue },
        }
      }
      const id = reqString(i.id, "input.id", 128)
      const issue = issuesDoc.issues[id]
      if (!issue) throw new StoreError("STORE_STATE", `unknown issue ${id}`)
      if (i.title !== undefined) issue.title = reqString(i.title, "input.title", TITLE_MAX_CHARS)
      if (i.topic !== undefined) issue.topic = optString(i.topic, "input.topic", 100)
      if (i.classification !== undefined) issue.classification = normalizeClassification(i.classification)
      if (i.status !== undefined && i.status !== issue.status) {
        const from = issue.status
        const to = i.status
        if (from !== "draft") {
          throw new StoreError("STORE_STATE", `issue ${id} is ${from}; triage transitions are only allowed from draft`)
        }
        if (to !== "approved" && to !== "merged" && to !== "dropped") {
          throw new StoreError("STORE_STATE", `issue transition draft → ${to} is not allowed`)
        }
        if (to === "merged") {
          const targetId = reqString(i.mergedInto, "input.mergedInto", 128)
          const target = issuesDoc.issues[targetId]
          if (!target) throw new StoreError("STORE_STATE", `mergedInto target ${targetId} does not exist`)
          if (targetId === id) throw new StoreError("STORE_STATE", "an issue cannot merge into itself")
          issue.mergedInto = targetId
        }
        issue.status = to
      } else if (i.mergedInto !== undefined) {
        throw new StoreError("STORE_INPUT", "mergedInto is only valid together with status: 'merged'")
      }
      issue.updatedAtTs = ts
      return {
        summary: `issue ${id} updated (${issue.status})`,
        outputs: new Map([["issues:replace", { path: FILE_ISSUES, kind: "replace", content: serializeDoc(issuesDoc, ctx) }]]),
        result: { issue },
      }
    })
  }

  /**
   * Convenience: merge donor issue into target. Both issues keep their own
   * events with their original sources untouched — only the candidate
   * linkage moves (P3 merge semantics, m1-plan §3).
   */
  mergeIssues(donorId, targetId) {
    const donor = this.upsertIssue({ id: reqString(donorId, "donorId", 128), status: "merged", mergedInto: reqString(targetId, "targetId", 128) })
    return { donor: donor.issue }
  }

  /**
   * Record one rule decision (D6): kind approve | reject | disable | enable |
   * delivery-enable | delivery-disable (the delivery kinds are the v6.2
   * system-ride authorization, §III.8).
   * - approve: object required (full approval object). Creates rule v1 or
   *   bumps the version of an existing rule; status active.
   * - reject: history-only record; rules.json untouched.
   * - disable: human-only (I.6); active → disabled, keeps body/targets.
   * - enable: human-only restart; disabled → active as a NEW version with a
   *   fresh approval object (never a silent revival of the old grant).
   * - delivery-enable: binds (ruleId, version, bodyHash, channel) for
   *   system-ride delivery. Requires the rule to exist, be active, and be on
   *   the system-ride channel, and the object to match the CURRENT rule
   *   version and body hash exactly — a re-approved (new-version) rule
   *   auto-invalidates the old delivery-enable. History-only (rules.json
   *   untouched); the ride-time matcher re-derives and re-verifies the
   *   quadruple from the decision log on every model request.
   * - delivery-disable: history-only stop record; matching stops appending
   *   on the next evaluation (historical replies and compressed summaries
   *   are not retroactively edited).
   * The decision record stores the canonical approval-object hash and its own
   * decisionHash; the rule's approvalRef points at the decision record hash
   * (display-confirm binding). Decisions are appended before rules.json is
   * replaced (D5 commit order). A disabled rule is never reactivated by
   * replaying old approvals — only an explicit enable decision does that.
   */
  recordDecision(input) {
    const i = reqObject(input, "input")
    const kind = reqString(i.kind, "input.kind", 16)
    if (
      kind !== "approve" && kind !== "reject" && kind !== "disable" && kind !== "enable" &&
      kind !== "delivery-enable" && kind !== "delivery-disable"
    ) {
      throw new StoreError(
        "STORE_INPUT",
        'input.kind must be "approve" | "reject" | "disable" | "enable" | "delivery-enable" | "delivery-disable"',
      )
    }
    const isDelivery = kind === "delivery-enable" || kind === "delivery-disable"
    const ruleId = i.ruleId === undefined || i.ruleId === null ? null : reqString(i.ruleId, "input.ruleId", 128)
    const approval = kind === "approve" || kind === "enable" ? normalizeApprovalObject(i.object) : null
    const note = kind === "approve" || kind === "enable" ? null : i.object === undefined ? null : reqObject(i.object, "input.object")
    const checklistKey =
      kind === "approve" ? "recordDecisionApprove"
      : kind === "reject" ? "recordDecisionReject"
      : kind === "disable" ? "recordDecisionDisable"
      : kind === "enable" ? "recordDecisionEnable"
      : isDelivery ? (kind === "delivery-enable" ? "recordDecisionDeliveryEnable" : "recordDecisionDeliveryDisable")
      : null
    if (!checklistKey) throw new StoreError("STORE_INPUT", `unhandled decision kind ${kind}`)
    return this.#write(checklistKey, (data, ctx) => {
      const rulesDoc = data.rulesDoc
      if (!rulesDoc || !isObj(rulesDoc.rules)) {
        throw new StoreError("STORE_CORRUPT", "rules.json is missing or malformed")
      }
      const ts = ctx.ts
      const decisionId = newId("DEC")
      // Approval objects hash the normalized approval; delivery bindings hash
      // the quadruple object. Pre-existing kinds (reject/disable/enable with
      // a note) keep objectHash null — record shape is unchanged for them.
      const objectHash =
        approval ? sha256Hex(canonicalJson(approval))
        : isDelivery && note ? sha256Hex(canonicalJson(note))
        : null
      const decisionBase = {
        type: "decision",
        v: SCHEMA_VERSION,
        id: decisionId,
        txnId: ctx.txnId,
        seq: ctx.seq,
        ts,
        kind,
        ruleId,
        objectHash,
        object: approval ?? note,
      }
      const decisionHash = sha256Hex(canonicalJson(decisionBase))
      const decision = { ...decisionBase, decisionHash }
      let rule = null
      if (kind === "approve") {
        if (ruleId !== null) {
          const prev = rulesDoc.rules[ruleId]
          if (!prev) throw new StoreError("STORE_STATE", `cannot approve unknown rule ${ruleId}`)
          rule = {
            ...prev,
            ...approval,
            version: prev.version + 1,
            status: "active",
            approvalRef: { decisionId, decisionHash },
            disabledRef: null,
            publishResult: null, // new body is not applied yet
            updatedAtTs: ts,
          }
        } else {
          rule = {
            id: newId("RUL"),
            version: 1,
            status: "active",
            ...approval,
            approvalRef: { decisionId, decisionHash },
            disabledRef: null,
            publishResult: null,
            createdAtTs: ts,
            updatedAtTs: ts,
          }
        }
        rulesDoc.rules[rule.id] = rule
      } else if (kind === "disable") {
        if (ruleId === null) throw new StoreError("STORE_INPUT", "disable requires input.ruleId")
        const prev = rulesDoc.rules[ruleId]
        if (!prev) throw new StoreError("STORE_STATE", `cannot disable unknown rule ${ruleId}`)
        if (prev.status !== "active") throw new StoreError("STORE_STATE", `rule ${ruleId} is ${prev.status}; only active rules can be disabled`)
        rule = { ...prev, status: "disabled", disabledRef: decisionHash, updatedAtTs: ts }
        rulesDoc.rules[ruleId] = rule
      } else if (kind === "enable") {
        if (ruleId === null) throw new StoreError("STORE_INPUT", "enable requires input.ruleId")
        const prev = rulesDoc.rules[ruleId]
        if (!prev) throw new StoreError("STORE_STATE", `cannot enable unknown rule ${ruleId}`)
        if (prev.status !== "disabled") throw new StoreError("STORE_STATE", `rule ${ruleId} is ${prev.status}; only disabled rules can be re-enabled`)
        rule = {
          ...prev,
          ...approval,
          version: prev.version + 1,
          status: "active",
          approvalRef: { decisionId, decisionHash },
          disabledRef: null,
          publishResult: null,
          updatedAtTs: ts,
        }
        rulesDoc.rules[ruleId] = rule
      } else if (kind === "delivery-enable") {
        // §III.8: bind (ruleId, version, bodyHash, channel) against the
        // CURRENT rule state; any mismatch is refused (fail-closed).
        if (ruleId === null) throw new StoreError("STORE_INPUT", "delivery-enable requires input.ruleId")
        const target = rulesDoc.rules[ruleId]
        if (!target) throw new StoreError("STORE_STATE", `delivery-enable references unknown rule ${ruleId}`)
        if (target.status !== "active") {
          throw new StoreError("STORE_STATE", `rule ${ruleId} is ${target.status}; only active rules can be delivery-enabled`)
        }
        if (target.channel !== "system-ride") {
          throw new StoreError("STORE_STATE", `rule ${ruleId} channel is ${target.channel ?? "unset"}; system-ride delivery applies only to rules approved on the system-ride channel`)
        }
        if (!note || typeof note !== "object" || Array.isArray(note)) {
          throw new StoreError("STORE_INPUT", "delivery-enable requires input.object {channel, version, bodyHash}")
        }
        if (note.channel !== "system-ride") {
          throw new StoreError("STORE_INPUT", 'delivery-enable object.channel must be "system-ride"')
        }
        if (note.version !== target.version) {
          throw new StoreError(
            "STORE_STATE",
            `delivery-enable binds version ${note.version} but rule ${ruleId} is v${target.version} — a re-approved rule resets delivery; record against the current version`,
          )
        }
        if (note.bodyHash !== sha256Hex(target.body)) {
          throw new StoreError("STORE_STATE", `delivery-enable bodyHash mismatch for rule ${ruleId} v${target.version} — the rule body changed; re-approve and re-bind`)
        }
      } else if (kind === "delivery-disable") {
        // Stop record: matching stops appending on the next evaluation.
        // The rule must exist; its current status is irrelevant (a disabled
        // rule already delivers nothing — the record keeps the log complete).
        if (ruleId === null) throw new StoreError("STORE_INPUT", "delivery-disable requires input.ruleId")
        if (!rulesDoc.rules[ruleId]) {
          throw new StoreError("STORE_STATE", `delivery-disable references unknown rule ${ruleId}`)
        }
      } else {
        // reject: history-only; a referenced ruleId must exist when given.
        if (ruleId !== null && !rulesDoc.rules[ruleId]) {
          throw new StoreError("STORE_STATE", `reject references unknown rule ${ruleId}`)
        }
      }
      const raw = data.raw[FILE_DECISIONS] ?? ""
      const line = JSON.stringify(decision) + "\n"
      const outputs = new Map([["decisions:append", { path: FILE_DECISIONS, kind: "append", line, content: raw + line }]])
      if (rule) {
        outputs.set("rules:replace", { path: FILE_RULES, kind: "replace", content: serializeDoc(rulesDoc, ctx) })
      }
      return {
        summary: `${kind} ${ruleId ?? rule?.id ?? "-"} decision ${decisionId}`,
        outputs,
        result: { decision, rule },
      }
    })
  }

  /**
   * Record the latest publish result for a rule (D9 bookkeeping: what the
   * user reported after hand-applying or removing the patch). Read-only
   * check consumers see this via listRules()/getRule().
   */
  recordPublishResult(ruleId, result) {
    const rid = reqString(ruleId, "ruleId", 128)
    const r = reqObject(result, "result")
    return this.#write("recordPublishResult", (data, ctx) => {
      const rulesDoc = data.rulesDoc
      if (!rulesDoc || !isObj(rulesDoc.rules)) {
        throw new StoreError("STORE_CORRUPT", "rules.json is missing or malformed")
      }
      const rule = rulesDoc.rules[rid]
      if (!rule) throw new StoreError("STORE_STATE", `unknown rule ${rid}`)
      rule.publishResult = {
        applied: r.applied === true,
        note: optString(r.note, "result.note", 1000),
        ts: typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : ctx.ts,
      }
      rule.updatedAtTs = ctx.ts
      return {
        summary: `publish result for ${rid} (applied=${rule.publishResult.applied})`,
        outputs: new Map([["rules:replace", { path: FILE_RULES, kind: "replace", content: serializeDoc(rulesDoc, ctx) }]]),
        result: { rule },
      }
    })
  }

  /**
   * Register or update a host project (II.1 scope keys): human-readable alias
   * plus directory associations. A new directory starts UNCONFIRMED
   * (R21-C3: a shared project_id from a fork/template clone stays unlinked
   * until the user confirms it here); confirmDirectory flips it explicitly.
   */
  upsertProject(input) {
    const i = reqObject(input, "input")
    const projectId = reqString(i.projectId, "input.projectId", 512)
    const alias = i.alias === undefined ? undefined : optString(i.alias, "input.alias", 200)
    let directory = null
    if (i.directory !== undefined && i.directory !== null) {
      directory = reqString(i.directory, "input.directory", 1024)
      if (!path.isAbsolute(directory)) throw new StoreError("STORE_INPUT", "input.directory must be an absolute path")
    }
    const confirm = i.confirmDirectory === true
    return this.#write("upsertProject", (data, ctx) => {
      const projectsDoc = data.projectsDoc
      if (!projectsDoc || !isObj(projectsDoc.projects)) {
        throw new StoreError("STORE_CORRUPT", "projects.json is missing or malformed")
      }
      const ts = ctx.ts
      let project = projectsDoc.projects[projectId]
      if (!project) {
        project = { id: projectId, alias: null, directories: [], createdAtTs: ts, updatedAtTs: ts }
        projectsDoc.projects[projectId] = project
      }
      if (alias !== undefined) project.alias = alias
      if (directory !== null) {
        const found = (project.directories ?? []).find((d) => d.path === directory)
        if (found) {
          if (confirm && !found.confirmed) {
            found.confirmed = true
            found.confirmedTs = ts
          }
        } else {
          project.directories = [
            ...(project.directories ?? []),
            { path: directory, confirmed: confirm, confirmedTs: confirm ? ts : null },
          ]
        }
      }
      project.updatedAtTs = ts
      return {
        summary: `project ${projectId} updated (${project.directories.length} director${project.directories.length === 1 ? "y" : "ies"})`,
        outputs: new Map([["projects:replace", { path: FILE_PROJECTS, kind: "replace", content: serializeDoc(projectsDoc, ctx) }]]),
        result: { project },
      }
    })
  }
}

// ---------- lifecycle ----------

/**
 * Explicit first initialization (D5 #5): creates the directory 0700, the five
 * store files 0600, the digest/ view directory, and the initial committed
 * commit marker. Refuses to touch an existing store (STORE_EXISTS) — a
 * missing store is never silently treated as a new install anywhere else.
 */
export function initStore(root) {
  if (typeof root !== "string" || root.length === 0) throw new StoreError("STORE_INPUT", "root must be a non-empty path string")
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw new StoreError("STORE_INPUT", `root exists and is not a directory: ${root}`)
  }
  const markerPath = path.join(root, FILE_MARKER)
  const anyStoreFile = STORE_FILES.some((f) => fs.existsSync(path.join(root, f)))
  if (fs.existsSync(markerPath) || anyStoreFile) {
    throw new StoreError("STORE_EXISTS", `store already initialized at ${root}; refusing to overwrite`)
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.chmodSync(root, 0o700)
  const initTxn = { txnId: "txn-1-init", seq: 1, op: "init", ts: Date.now() }
  const docs = {
    [FILE_RULES]: { rules: {} },
    [FILE_ISSUES]: { issues: {} },
    [FILE_PROJECTS]: { projects: {} },
  }
  for (const [name, data] of Object.entries(docs)) {
    writeFileAtomic(path.join(root, name), JSON.stringify({ schema: SCHEMA_ID, version: SCHEMA_VERSION, lastTxn: initTxn, ...data }, null, 2) + "\n")
  }
  for (const name of JSONL_FILES) {
    const p = path.join(root, name)
    const fd = fs.openSync(p, "wx", 0o600)
    fs.closeSync(fd)
    fs.chmodSync(p, 0o600)
  }
  fs.mkdirSync(path.join(root, DIR_DIGEST), { recursive: true, mode: 0o700 })
  writeMarker(root, {
    schema: SCHEMA_ID,
    version: SCHEMA_VERSION,
    txnId: initTxn.txnId,
    seq: 1,
    prevSeq: 0,
    op: "init",
    summary: "explicit first initialization (empty skeleton)",
    steps: ["marker:pending", "marker:commit"],
    phase: "committed",
    files: [],
    startedTs: initTxn.ts,
    committedTs: Date.now(),
  })
  return { root, files: [...STORE_FILES, FILE_MARKER], digestDir: path.join(root, DIR_DIGEST) }
}

/**
 * Open an existing store. Rejects a missing store with STORE_MISSING (a
 * missing store is NOT a fresh install — D5 #5). Damaged or incompletely
 * committed stores open successfully but with health.status "corrupt" /
 * "incomplete_commit"; every mutation then throws and authorization outputs
 * must stay closed (D5 #3/#4) — use doctor() to report the difference.
 * @returns {Store}
 */
export function openStore(root, opts = {}) {
  if (typeof root !== "string" || root.length === 0) throw new StoreError("STORE_INPUT", "root must be a non-empty path string")
  const normOpts = normalizeOpts(opts)
  const h = evaluateHealth(root, normOpts)
  if (h.status === "missing") {
    throw new StoreError(
      "STORE_MISSING",
      `no memory store at ${root} — a missing store is not a fresh install; run the explicit init command first`,
    )
  }
  return new Store(root, normOpts, h)
}
