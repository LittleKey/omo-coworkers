// Shared execute-time helpers for the supervisor-memory tool face (P2 +
// v6.0 Part III step 1a). Extracted from tool.mjs so the per-tool modules
// (draft/publish/view) can reuse them without circular imports — tool.mjs
// wires all tools and must not be imported from below.
//
// Host facts (P0 A1, unchanged): the tool execute context carries no parent
// or project info, and the registration ctx's location is the plugin
// instance's load location, not the session's. Both the root/subagent
// discrimination AND the current session's project identity therefore come
// from the host DB read-only at execute time:
//   SELECT id, parent_id, project_id FROM session_v2 WHERE id = ?
// Missing session row, non-null parent_id, or NULL/empty project_id →
// reject, fail-closed.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { openStore, StoreError, defaultMemoryRoot } from "./store.mjs"
import { defaultHostDbPath, openHostDbReadOnly } from "./evidence.mjs"


export const SESSION_SQL = "SELECT id, parent_id, project_id FROM session_v2 WHERE id = ?"

export function checkCurrentSession({ dbPath, sessionID }) {
  let db
  let row
  try {
    if (!fs.existsSync(dbPath)) {
      return { ok: false, reason: `host database not found at ${dbPath} — cannot verify root/subagent session, refusing (fail-closed)` }
    }
    db = openHostDbReadOnly(dbPath)
    row = db.prepare(SESSION_SQL).get(sessionID)
  } catch (err) {
    return { ok: false, reason: `host database read failed: ${err?.message ?? err} — refusing (fail-closed)` }
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
  if (!row) {
    return { ok: false, reason: `current session ${sessionID} is not in the host database — refusing (fail-closed)` }
  }
  if (row.parent_id !== null && row.parent_id !== undefined) {
    return { ok: false, reason: "current session is a child session (parent_id non-null); memory tools can only be used in a root session" }
  }
  if (typeof row.project_id !== "string" || row.project_id.length === 0) {
    return { ok: false, reason: "current session has no project identity (session_v2.project_id is empty) — rejected (fail-closed)" }
  }
  return { ok: true, projectId: row.project_id }
}

/**
 * Shared first gate for every memory tool execute: session id present,
 * current session is a root session, project identity derived from the host
 * DB. Returns {ok:true, sessionID, projectId, dbPath} or {ok:false, error}.
 */
export function gateSession(context, cfg) {
  const sessionID = context?.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    return { ok: false, error: "missing session identity, cannot determine root/child session — rejected (fail-closed)" }
  }
  const dbPath = cfg.dbPath ?? defaultHostDbPath()
  const session = checkCurrentSession({ dbPath, sessionID })
  if (!session.ok) return { ok: false, error: session.reason }
  return { ok: true, sessionID, projectId: session.projectId, dbPath }
}

export function openStoreFor(cfg) {
  return openStore(cfg.storeRoot ?? defaultMemoryRoot())
}

/**
 * Structured error envelope (Oracle R33 tool-face phase 1). Every tool
 * failure returns ONE shape: {ok:false, code, message, nextTool, retry}.
 *   code     stable "MEMORY_<CODE>"; the STORE_* family passes the store's
 *            own stable codes through unchanged (STORE_MISSING, STORE_LOCKED,
 *            STORE_CORRUPT/PERM/INCOMPLETE/STATE/…)
 *   message  one sentence of reason + fix — lazy help lives here, never in
 *            the tool descriptions
 *   nextTool null in this phase (memory_status exposes no ids, so no next
 *            tool call helps)
 *   retry    "safe" — transient, retrying the same call is safe (held lock)
 *            "requires_user_confirmation" — a human must act first
 *            (init / repair / target review)
 *            "never" — retrying unchanged is pointless or forbidden
 *            (fix the arguments, or the outcome is policy)
 */
export function memoryError(code, message, { nextTool = null, retry = "never" } = {}) {
  return { ok: false, code: `MEMORY_${code}`, message: String(message), nextTool, retry }
}

/** Structured envelope for a fail-closed session/identity gate rejection. */
export function sessionRejected(reason) {
  return memoryError(
    "SESSION_REJECTED",
    `${reason} — memory tools run only in a root session whose session_v2 row exists and carries project_id; retries cannot change session identity`,
  )
}

/** Structured envelope for a closed/unavailable store (never auto-init). */
export function storeOpenError(err) {
  if (err instanceof StoreError) {
    if (err.code === "STORE_MISSING") {
      return memoryError(
        "STORE_MISSING",
        "memory store is not initialized — run the supervisor-memory CLI init command first (a missing store is never auto-created)",
        { retry: "requires_user_confirmation" },
      )
    }
    if (err.code === "STORE_LOCKED") {
      return memoryError(
        "STORE_LOCKED",
        `memory store is locked by another process — retry the same call shortly (${err?.message ?? err})`,
        { retry: "safe" },
      )
    }
    return memoryError(
      err.code, // STORE_CORRUPT / STORE_PERM / STORE_INCOMPLETE / STORE_STATE / … — the store's stable family
      `memory store is unavailable (${err.code}): ${err?.message ?? err} — repair it via the supervisor-memory CLI digest command (fail-closed)`,
      { retry: "requires_user_confirmation" },
    )
  }
  return memoryError(
    "STORE_UNKNOWN",
    `memory store failed to open: ${err?.message ?? err} — repair it via the supervisor-memory CLI digest command (fail-closed)`,
    { retry: "requires_user_confirmation" },
  )
}

/**
 * Map a StoreError from any store call to its structured envelope (the
 * store's own stable code family passes through via storeOpenError); any
 * other error is rethrown and stays an INTERNAL envelope at the tool
 * boundary. STORE_INPUT means the tool assembled a bad store argument — a
 * tool bug, not a store condition, so it is not passed through either.
 */
export function mapStoreError(err) {
  if (err instanceof StoreError && err.code !== "STORE_INPUT") return storeOpenError(err)
  throw err
}

/** Isolated directory for mock receipts — never the production store root. */
export function defaultMockDir() {
  return path.join(os.tmpdir(), "opencode-supervisor-memory-mock")
}

export function writeMockReceipt(mockDir, receipt) {
  const dir = mockDir ?? defaultMockDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const safeSession = String(receipt.sessionId).replace(/[^A-Za-z0-9_-]/g, "_")
  const file = path.join(dir, `${safeSession}.jsonl`)
  fs.appendFileSync(file, JSON.stringify(receipt) + "\n", { mode: 0o600 })
}
