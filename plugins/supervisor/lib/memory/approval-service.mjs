// Shared approval service layer (oracle R33+ phase 3). ONE source of logic
// for every path that records an authorization/stop decision — the CLI
// (approve / delivery-enable / delivery-disable / disable) and the memory_*
// tools both submit through submitDecision().
//
// Bug ① fix (TOCTOU): before this layer, the CLI re-verified the store
// fingerprint at stage 3 (cli/approve.mjs "before/after") and only afterwards
// called store.recordDecision — two concurrent approvers could both pass the
// re-check against the same displayed version and commit two version bumps,
// because recordDecision's approve branch (store.mjs) intentionally does not
// compare the displayed version (the store transaction algorithm is NOT
// changed by this fix). The critical section here serializes
// "final re-check + recordDecision" across PROCESSES with an independent
// lock file (<root>/approval.lock — never the store's own `lock` file, whose
// lifecycle belongs to store transactions):
//
//   acquire approval.lock → re-snapshot the store → compare with the
//   snapshot captured at DISPLAY time → mismatch ⇒ refuse (nothing
//   recorded) → match ⇒ recordDecision → release.
//
// The lock is held only across that short critical section — never while
// waiting for the user (display/confirmation always happens before
// submitDecision is called).
//
// Post-submit failures must carry the decisionId (adjudication): once the
// decision is recorded, every later failure surface reports it so callers
// never re-approve "to be safe" — a second approve is a new version, not a
// retry.

import fs from "node:fs"
import path from "node:path"

import { canonicalJson, sha256Hex } from "./store.mjs"
import { deriveDeliveryState, rideBodyHash, RIDE_CHANNEL } from "./ride.mjs"

/** Display-time store state a confirmation is bound to (T3 fingerprint). */
export function snapshotState(store, { ruleId = null, issueId = null } = {}) {
  const decisions = store.listDecisions()
  const rule = ruleId ? store.getRule(ruleId) : null
  const issue = issueId ? store.getIssue(issueId) : null
  let delivery = null
  if (rule) delivery = deriveDeliveryState(rule, decisions).enabled
  return {
    decisionsTotal: decisions.length,
    rule: rule
      ? {
          version: rule.version,
          status: rule.status,
          updatedAtTs: rule.updatedAtTs,
          approvalDecisionId: rule.approvalRef?.decisionId ?? null,
          deliveryEnabled: delivery,
        }
      : null,
    issue: issue ? { status: issue.status, updatedAtTs: issue.updatedAtTs } : null,
  }
}

export function sameState(a, b) {
  return canonicalJson(a) === canonicalJson(b)
}

/** Confirmation invalidated: submit-time state no longer matches the display. */
export class ApprovalStaleError extends Error {
  constructor(detail) {
    super(
      `confirmation invalidated: the store state at submission no longer matches the state shown to the user (${detail}) — a confirmation never survives an object/scope/agent/channel/target/status change; rebuild the object, show it again, and record a FRESH decision`,
    )
    this.name = "ApprovalStaleError"
    this.code = "MEMORY_CONFIRMATION_STALE"
    this.detail = detail
  }
}

/** Another process holds the approval critical section. */
export class ApprovalConflictError extends Error {
  constructor(detail) {
    super(`another approval/stop decision is being submitted for this store (${detail}) — retry shortly; nothing was recorded`)
    this.name = "ApprovalConflictError"
    this.code = "MEMORY_APPROVAL_BUSY"
  }
}

export const APPROVAL_LOCK_FILE = "approval.lock"
export const DEFAULT_STALE_MS = 30_000
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000
export const DEFAULT_POLL_MS = 25
export const DEFAULT_PID_GRACE_MS = 250

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "ESRCH" ? false : true
  }
}

function lockRecoverable(lockPath, { staleMs, pidGraceMs, now = Date.now }) {
  let st
  let text = null
  try {
    st = fs.statSync(lockPath)
    text = fs.readFileSync(lockPath, "utf8")
  } catch {
    return { exists: false }
  }
  const ageMs = Math.max(0, now() - st.mtimeMs)
  let info = null
  try {
    info = JSON.parse(text)
  } catch {
    info = null
  }
  const pid = info && Number.isInteger(info.pid) ? info.pid : null
  const ts = info && Number.isInteger(info.ts) ? info.ts : null
  const heartbeatAgeMs = ts !== null ? Math.max(0, now() - ts) : null
  if (pid === null) return { exists: true, recoverable: ageMs > staleMs }
  const alive = pidAlive(pid)
  if (alive === false && ageMs > pidGraceMs) return { exists: true, recoverable: true }
  if (heartbeatAgeMs !== null) return { exists: true, recoverable: heartbeatAgeMs > staleMs }
  return { exists: true, recoverable: ageMs > staleMs }
}

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(shared), 0, 0, ms)
}

/**
 * Cross-process short critical section over <root>/approval.lock.
 * O_EXCL create; a provably-dead holder or an expired heartbeat/mtime is
 * recovered (same policy shape as the store lock, separate file). fn runs
 * with no arguments; the lock is always released in finally.
 */
export function withApprovalLock(root, fn, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const pidGraceMs = opts.pidGraceMs ?? DEFAULT_PID_GRACE_MS
  const lockPath = path.join(root, APPROVAL_LOCK_FILE)
  const deadline = Date.now() + timeoutMs
  let fd = null
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600)
      break
    } catch (e) {
      if (e.code !== "EEXIST") {
        throw new ApprovalConflictError(`cannot create ${APPROVAL_LOCK_FILE}: ${e.code}`)
      }
      const info = lockRecoverable(lockPath, { staleMs, pidGraceMs })
      if (info.recoverable) {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* someone else recovered it; loop retries */
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new ApprovalConflictError(`approval lock held by another process (${lockPath})`)
      }
      sleepSync(pollMs)
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), { mode: 0o600 })
  } catch {
    /* lock content is advisory (pid/heartbeat); the O_EXCL create is the mutex */
  }
  try {
    fs.closeSync(fd)
  } catch {
    /* ignore */
  }
  try {
    return fn()
  } finally {
    try {
      fs.unlinkSync(lockPath)
    } catch {
      /* a recoverable holder cleans up later */
    }
  }
}

/**
 * THE critical section: final re-check of the display-time snapshot followed
 * by store.recordDecision, atomic across processes. Never call this while
 * still waiting for the user — confirmation must be complete first.
 *
 * @param p.store          open Store (requireHealthy() is the caller's gate)
 * @param p.kind           recordDecision kind (approve/enable/disable/
 *                         delivery-enable/delivery-disable/reject)
 * @param p.ruleId         rule id or null (approve mints a new rule)
 * @param p.issueId        issue id for the snapshot (approve-of-issue flow)
 * @param p.object         decision object (approval object / binding / note)
 * @param p.snapshot       snapshotState() captured when the object was shown
 * @param p.expectRule     optional extra predicate (rule) → string|null error,
 *                         evaluated inside the lock before recording
 * @returns {decision, rule, objectHash}
 */
export function submitDecision(p) {
  const { store, kind, ruleId = null, issueId = null, object = undefined, snapshot } = p
  return withApprovalLock(store.root, () => {
    const fresh = snapshotState(store, { ruleId, issueId })
    // A missing snapshot means "no display-time state to protect" (stop-class
    // commands with no wait between check and record) — the fresh in-lock
    // snapshot is then the caller's validated state. Snapshot-guarded flows
    // MUST always pass one.
    if (snapshot !== undefined && !sameState(snapshot, fresh)) {
      throw new ApprovalStaleError(`display snapshot ${shortHash(snapshot)} ≠ current ${shortHash(fresh)}`)
    }
    if (typeof p.expectRule === "function" && ruleId !== null) {
      const problem = p.expectRule(store.getRule(ruleId))
      if (problem) throw new ApprovalStaleError(problem)
    }
    const { decision, rule } = store.recordDecision({ kind, ruleId, object })
    return { decision, rule, objectHash: decision.objectHash ?? null }
  })
}

function shortHash(v) {
  return sha256Hex(canonicalJson(v)).slice(0, 12)
}

/**
 * Human-facing rendering of a submitDecision failure for the CLI layer —
 * keeps the exact code families the CLI already prints.
 */
export function describeSubmitError(e) {
  if (e instanceof ApprovalStaleError) {
    return `confirmation invalidated: ${e.detail}\nsilent retries are forbidden: re-run the command and re-confirm from the beginning. No decision was recorded this time.`
  }
  if (e instanceof ApprovalConflictError) return `error[MEMORY_APPROVAL_BUSY] ${e.message}`
  return null
}
