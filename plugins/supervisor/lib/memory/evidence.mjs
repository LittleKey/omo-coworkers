// Evidence validation for report_correction (m1-plan §2 D4, design v5.0
// II.1 证据与溯源). Full D4 semantics, fail-closed:
//   ① the message must exist in the host DB with type='user'
//   ② its session's project_id must equal the current ctx.location.project.id
//   ③ its session's parent_id must be null (a subagent session's "user
//     messages" are synthetic task prompts — always rejected)
//   ④ an unreadable / missing / failing DB is a rejection — never degrade to
//     accepting (fail-closed)
//   ⑤ the excerpt is truncated to store.EVIDENCE_MAX_CHARS
//
// Host facts (P0 A1, docs/supervisor-memory-m1-p0.md): the plugin runs under
// Bun where `node:sqlite` DatabaseSync opens <home>/.local/share/opencode/
// opencode.db readOnly; node >= 22.5 tests use the same module. The verified
// cross-session evidence SQL is kept verbatim from P0:
//   SELECT m.id, m.session_id, m.type, json_extract(m.data,'$.text') text,
//          s.project_id, s.parent_id, s.agent
//   FROM session_message m LEFT JOIN session_v2 s ON s.id=m.session_id
//   WHERE m.id=?

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { EVIDENCE_MAX_CHARS } from "./store.mjs"

/** Host OpenCode database (P0-verified readOnly path). */
export function defaultHostDbPath() {
  return path.join(os.homedir(), ".local/share/opencode/opencode.db")
}

/** Open the host DB read-only; throws on any failure (callers fail closed). */
export function openHostDbReadOnly(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true })
}

// P0-verified cross-session evidence query (kept verbatim).
const EVIDENCE_SQL = [
  "SELECT m.id mid, m.session_id sid, m.type mtype,",
  "       s.project_id pid, s.parent_id parent, s.agent agent,",
  "       json_extract(m.data,'$.text') text",
  "FROM session_message m LEFT JOIN session_v2 s ON s.id = m.session_id",
  "WHERE m.id = ?",
].join(" ")

/**
 * Validate one evidence message ID against D4. Returns
 * {ok:true, excerpt, sessionId, projectIds:[…]} or {ok:false, reason}.
 * `dbPath` may be injected for tests; default is the host DB under $HOME.
 */
export function validateEvidence({ dbPath, messageId, currentProjectId }) {
  if (typeof messageId !== "string" || messageId.length === 0) {
    return { ok: false, reason: "evidence message id must be a non-empty string" }
  }
  if (typeof currentProjectId !== "string" || currentProjectId.length === 0) {
    return { ok: false, reason: "current project id is unavailable — evidence cannot be verified, refusing (fail-closed)" }
  }
  const file = typeof dbPath === "string" && dbPath.length > 0 ? dbPath : defaultHostDbPath()
  let db
  let row
  try {
    if (!fs.existsSync(file)) {
      return { ok: false, reason: `host database not found at ${file} — evidence unverifiable, refusing (fail-closed)` }
    }
    db = openHostDbReadOnly(file)
    row = db.prepare(EVIDENCE_SQL).get(messageId)
  } catch (err) {
    return { ok: false, reason: `host database read failed: ${err?.message ?? err} — refusing (fail-closed)` }
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
  // ① exists + is a real user message
  if (!row) {
    return { ok: false, reason: `message ${messageId} does not exist in the host database (fail-closed)` }
  }
  if (row.mtype !== "user") {
    return { ok: false, reason: `message ${messageId} is type ${JSON.stringify(row.mtype)}, not a user message` }
  }
  // ② same project only
  if (typeof row.pid !== "string" || row.pid.length === 0) {
    return { ok: false, reason: `session of message ${messageId} has no project identity — refusing (fail-closed)` }
  }
  if (row.pid !== currentProjectId) {
    return { ok: false, reason: `message ${messageId} belongs to another project — only same-project evidence is accepted` }
  }
  // ③ subagent sources are always rejected (synthetic task prompts)
  if (row.parent !== null && row.parent !== undefined) {
    return { ok: false, reason: `message ${messageId} comes from a subagent session (parent_id set) — rejected` }
  }
  // ⑤ excerpt truncated to EVIDENCE_MAX_CHARS; no extractable text → reject
  //    (store.mjs requires a non-empty excerpt, so fail here, upstream-proof)
  const text = typeof row.text === "string" ? row.text : ""
  if (text.length === 0) {
    return { ok: false, reason: `message ${messageId} has no extractable text — refusing (fail-closed)` }
  }
  return {
    ok: true,
    excerpt: text.slice(0, EVIDENCE_MAX_CHARS),
    sessionId: row.sid,
    projectIds: [row.pid],
  }
}
