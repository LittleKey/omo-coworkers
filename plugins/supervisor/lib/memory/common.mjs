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
    return { ok: false, reason: "当前会话是子会话 (parent_id 非 null); memory 工具只能在根会话使用" }
  }
  if (typeof row.project_id !== "string" || row.project_id.length === 0) {
    return { ok: false, reason: "当前会话缺少项目身份 (session_v2.project_id 为空) — 拒绝 (fail-closed)" }
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
    return { ok: false, error: "缺少会话标识, 无法判定根/子会话 — 拒绝 (fail-closed)" }
  }
  const dbPath = cfg.dbPath ?? defaultHostDbPath()
  const session = checkCurrentSession({ dbPath, sessionID })
  if (!session.ok) return { ok: false, error: session.reason }
  return { ok: true, sessionID, projectId: session.projectId, dbPath }
}

export function openStoreFor(cfg) {
  return openStore(cfg.storeRoot ?? defaultMemoryRoot())
}

/** Human-facing hint for a closed/unavailable store (never auto-init). */
export function storeOpenError(err) {
  if (err instanceof StoreError && err.code === "STORE_MISSING") {
    return "memory store 未初始化 — 请先运行 supervisor-memory CLI 的 init 命令(缺失的库不会被自动创建)"
  }
  const code = err instanceof StoreError ? err.code : "UNKNOWN"
  return `memory store 打开失败 (${code}): ${err?.message ?? err} — 本次拒绝(fail-closed)`
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
