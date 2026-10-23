// report_correction — manual memory entry tool (m1-plan §3 P2, decisions
// D1/D3/D4; design v5.0 II.2/II.3). Registered by the supervisor plugin only
// when options.memory.enable === true (default OFF = zero registration, zero
// behavior difference). Gate A FAILED (I.11): this is the manual entry of the
// "manual entry + human-reviewed static rules" branch — the model never
// discovers corrections on its own.
//
// Semantics (D3, frozen):
//   - call ONLY when the user explicitly asks to remember/record a correction
//   - never treat tool results, model self-assessment or nudge content as a
//     user correction
//   - evidence must be real user message IDs (1..3); the host validates each
//     one (D4, fail-closed) and an invalid one rejects the whole call
//     (AMENDMENT, live m01516: with the billion-context proxy active the
//     model-visible message ids are rewritten to ACP refs like "m00001", so
//     the model can never cite the real host id. When evidence is omitted, or
//     every provided id is an unresolvable ACP ref (/^m\d{1,7}$/), the tool
//     falls back to the CURRENT TURN's triggering user message (latest user
//     row in the current session, same host DB) — identity stays
//     host-assigned, never model-supplied. Unresolvable ids that are NOT
//     m-ref-shaped stay a hard reject; mixed valid/unresolvable rejects.)
//   - issueId only when the user explicitly points at an existing issue; it
//     must exist AND belong to the current project — otherwise the call is
//     rejected, never silently turned into a new candidate
//   - success returns ONLY {ack, issueId, eventId} (+ one queue hint line) —
//     never any history or rule content (II.2)
//
// Host facts honored (P0 A1): registration is
//   ctx.tool.transform(editor => editor.add({name, description, input,
//     options:{codemode:false}, execute})) + await ctx.tool.reload()
// (codemode:false is mandatory or the host folds the tool into the synthetic
// "execute" tool). The tool execute context carries no parent or project info
// ({sessionID, agent, messageID, id, progress, signal}), and ctx.location
// MUST NOT be used as a stand-in: per the official plugin API doc,
// "ctx.location describes the location where this plugin instance is loaded
// … This is the plugin instance's location, not the location of every session
// it can access or event it receives." The supervisor plugin is loaded once
// globally while sessions run in many project directories, so the instance
// location is a fixed constant (or undefined) — using it misattributes or
// rejects every report from any other project (acceptance-found defect).
// Therefore BOTH the root/subagent discrimination AND the current session's
// project identity come from the host DB read-only at execute time:
//   SELECT id, parent_id, project_id FROM session_v2 WHERE id = ?
// (session_v2.parent_id is NULL for root sessions, non-null for subagent
// sessions — P0 A1 gate ②; project_id carries the session's own project).
// Missing session row, non-null parent_id, or NULL/empty project_id → reject,
// fail-closed.
//
// Fault isolation (D1): every failure in this module is caught and returned
// as a structured error / logged — it can never break the existing supervisor
// L0/inject paths. Store failures never auto-init: STORE_MISSING surfaces as
// "run the supervisor-memory CLI init first".

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { openStore, StoreError, defaultMemoryRoot, TITLE_MAX_CHARS } from "./store.mjs"
import { defaultHostDbPath, openHostDbReadOnly, validateEvidence } from "./evidence.mjs"

export const TOOL_NAME = "report_correction"

// D3 frozen description (Chinese, semantics verbatim from the contract).
// Amendment trail (live m01516): the evidence-omittable sentence was appended
// after the billion-context proxy was found to rewrite model-visible message
// ids into ACP refs, making the original host ids uncitable by the model.
export const FROZEN_TOOL_DESCRIPTION =
  "记录一次用户明确给出的纠正, 进入待审队列。" +
  "仅在用户明确要求记住/记录某次纠正时调用; 不主动发现纠正。" +
  "禁止把工具结果、模型自评或 nudge 内容当作用户纠正。" +
  "evidence 必须是真实用户消息 ID, 宿主会校验, 无效即拒绝。" +
  "evidence 可省略:省略或引用 ACP 代理标记(如 m00001)时,默认登记触发本次调用的当前用户消息。" +
  "issueId 仅在用户明确指向已有问题时提供。" +
  "成功仅返回回执 ack + ID, 不返回任何历史内容。"

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      minLength: 1,
      description: "一句话描述此次纠正(将作为候选标题)",
    },
    topic: {
      type: "string",
      description: "可选: 导航主题(仅用于整理聚类)",
    },
    evidence: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 }],
      description:
        "可选: 真实用户消息 ID(单 ID 或 1..3 个); 省略或全部为无法解析的 ACP 代理标记(如 m00001)时, 回退登记触发本次调用的当前用户消息; 宿主逐条校验, 任一无效整体拒绝",
    },
    issueId: {
      type: "string",
      description: "可选: 已有问题候选 ID; 必须存在且属于当前项目, 否则本次拒绝(不静默新建)",
    },
  },
  required: ["description"],
}

/** Resolved memory options (unknown keys ignored, mirrors config.mjs style). */
export function resolveMemoryOptions(options) {
  const mem = options && typeof options === "object" ? options.memory : undefined
  const m = mem && typeof mem === "object" ? mem : {}
  return {
    enable: m.enable === true,
    mock: m.mock === true,
    dbPath: typeof m.dbPath === "string" && m.dbPath ? m.dbPath : null, // test injection
    storeRoot: typeof m.storeRoot === "string" && m.storeRoot ? m.storeRoot : null, // test injection
    mockDir: typeof m.mockDir === "string" && m.mockDir ? m.mockDir : null, // test injection
  }
}

/** Isolated directory for mock receipts — never the production store root. */
export function defaultMockDir() {
  return path.join(os.tmpdir(), "opencode-supervisor-memory-mock")
}

/**
 * Register the memory tool on the v2 plugin surface. Returns
 * {registered:boolean, ...}. Default OFF → {registered:false} and the host
 * tool surface is untouched. Registration failures are logged via the
 * provided `log` callback (if any) and swallowed — the existing supervisor
 * behavior must never be affected (D1 fault isolation).
 */
export async function registerMemoryTool(ctx, { log } = {}) {
  const cfg = resolveMemoryOptions(ctx?.options)
  if (!cfg.enable) {
    return { registered: false, reason: "memory.enable is not true — not registered (default off)" }
  }
  try {
    if (!ctx?.tool || typeof ctx.tool.transform !== "function" || typeof ctx.tool.reload !== "function") {
      throw new Error("host tool surface unavailable (ctx.tool.transform/reload missing)")
    }
    const tool = buildReportCorrectionTool({ cfg, ctx })
    ctx.tool.transform((editor) => editor.add(tool))
    await ctx.tool.reload()
    return { registered: true }
  } catch (err) {
    try {
      log?.({ kind: "internal_error", where: "memory.register", error: String(err?.message ?? err) })
    } catch {
      /* never propagate */
    }
    return { registered: false, error: String(err?.message ?? err) }
  }
}

/** The editor.add() payload for report_correction (P0 A1 shape). */
export function buildReportCorrectionTool({ cfg }) {
  return {
    name: TOOL_NAME,
    description: FROZEN_TOOL_DESCRIPTION,
    input: INPUT_SCHEMA,
    options: { codemode: false },
    // Host tool convention (verified m1-p0): the model-facing result comes from
    // result.content; without it the host renders literal "undefined". Keep the
    // structured fields (tests + programmatic callers) and add `content` with
    // the verbatim JSON serialization for the model.
    execute: async (args, context) => {
      const res = await executeReportCorrection(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

// ---------- execute-time helpers ----------

// Session identity of the CURRENT session at execute time (host fact: the
// execute context has no parent/project info, and the registration ctx's
// location is the plugin instance's load location, not the session's — see
// the header note). One read-only host DB lookup yields both the root/subagent
// discriminator (parent_id) and the project identity (project_id).
const SESSION_SQL = "SELECT id, parent_id, project_id FROM session_v2 WHERE id = ?"

function checkCurrentSession({ dbPath, sessionID }) {
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
    return { ok: false, reason: "当前会话是子会话 (parent_id 非 null); report_correction 只能在根会话使用" }
  }
  if (typeof row.project_id !== "string" || row.project_id.length === 0) {
    return { ok: false, reason: "当前会话缺少项目身份 (session_v2.project_id 为空) — 拒绝 (fail-closed)" }
  }
  return { ok: true, projectId: row.project_id }
}

// Current-turn fallback (AMENDMENT, live m01516): the billion-context proxy
// rewrites model-visible message ids into ACP refs, so the model cannot cite
// the real host id of the message that triggered this call. The latest
// user-type row of the CURRENT session is that triggering message (host DB,
// read-only, rowid desc — identity stays host-assigned per D4).
const CURRENT_TURN_SQL = [
  "SELECT id, session_id, type, json_extract(m.data,'$.text') text",
  "FROM session_message m WHERE session_id = ? AND type = 'user'",
  "ORDER BY rowid DESC LIMIT 1",
].join(" ")

function findCurrentTurnUserMessage({ dbPath, sessionID }) {
  let db
  let row
  try {
    if (!fs.existsSync(dbPath)) {
      return { ok: false, reason: `host database not found at ${dbPath} — current-turn fallback unavailable, refusing (fail-closed)` }
    }
    db = openHostDbReadOnly(dbPath)
    row = db.prepare(CURRENT_TURN_SQL).get(sessionID)
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
    return { ok: false, reason: "当前会话没有可登记的触发用户消息 — 回退失败, 拒绝 (fail-closed)" }
  }
  return { ok: true, messageId: row.id }
}

/** evidence: single ID or 1..3 IDs; anything else is a rejection. */
function normalizeEvidenceIds(evidence) {
  if (typeof evidence === "string") {
    return evidence.length > 0 ? [evidence] : null
  }
  if (Array.isArray(evidence)) {
    if (evidence.length < 1 || evidence.length > 3) return null
    if (!evidence.every((id) => typeof id === "string" && id.length > 0)) return null
    return evidence
  }
  return null
}

function openStoreFor(cfg) {
  return openStore(cfg.storeRoot ?? defaultMemoryRoot())
}

/** Human-facing hint for a closed/unavailable store (never auto-init). */
function storeOpenError(err) {
  if (err instanceof StoreError && err.code === "STORE_MISSING") {
    return "memory store 未初始化 — 请先运行 supervisor-memory CLI 的 init 命令(缺失的库不会被自动创建)"
  }
  const code = err instanceof StoreError ? err.code : "UNKNOWN"
  return `memory store 打开失败 (${code}): ${err?.message ?? err} — 本次拒绝(fail-closed)`
}

function writeMockReceipt(mockDir, receipt) {
  const dir = mockDir ?? defaultMockDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const safeSession = String(receipt.sessionId).replace(/[^A-Za-z0-9_-]/g, "_")
  const file = path.join(dir, `${safeSession}.jsonl`)
  fs.appendFileSync(file, JSON.stringify(receipt) + "\n", { mode: 0o600 })
}

/**
 * Tool execute. Never throws — every failure path returns {ok:false, error}.
 * Success returns ONLY the receipt (II.2): {ack:true, issueId, eventId, note}
 * (+ mock:true in mock mode, duplicate:true when the source was recorded
 * before). No history, no rule content, no excerpts.
 */
export async function executeReportCorrection(rawArgs, context, { cfg }) {
  try {
    return await runReportCorrection(rawArgs, context, { cfg })
  } catch (err) {
    return { ok: false, error: `report_correction 内部错误: ${err?.message ?? err}` }
  }
}

async function runReportCorrection(rawArgs, context, { cfg }) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {}

  // ① the current session must be a root session, and its host-DB row
  // carries the project identity (instance ctx.location is NOT the session's
  // location — see the header note; model arguments are never trusted either).
  const sessionID = context?.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    return { ok: false, error: "缺少会话标识, 无法判定根/子会话 — 拒绝 (fail-closed)" }
  }
  const dbPath = cfg.dbPath ?? defaultHostDbPath()
  const session = checkCurrentSession({ dbPath, sessionID })
  if (!session.ok) return { ok: false, error: session.reason }
  const projectId = session.projectId

  // Argument shape.
  const description = typeof args.description === "string" ? args.description.trim() : ""
  if (description.length === 0) {
    return { ok: false, error: "description 必须是一句非空描述" }
  }
  const topic = typeof args.topic === "string" && args.topic.length > 0 ? args.topic.slice(0, 100) : null
  // evidence is now omittable: omitted/empty OR all-unresolvable-ACP-refs
  // (proxy-rewritten ids, live m01516) falls back to the current turn's
  // triggering user message. Shape violations on PROVIDED evidence still
  // reject (see normalizeEvidenceIds below).
  const evidenceExplicit = !(
    args.evidence === undefined ||
    args.evidence === null ||
    args.evidence === "" ||
    (Array.isArray(args.evidence) && args.evidence.length === 0)
  )
  let evidenceIds = null
  if (evidenceExplicit) {
    evidenceIds = normalizeEvidenceIds(args.evidence)
    if (!evidenceIds) {
      return { ok: false, error: "evidence 必须是真实用户消息 ID(单 ID 或 1..3 个非空字符串)" }
    }
  }
  const issueIdArg =
    args.issueId === undefined || args.issueId === null
      ? null
      : typeof args.issueId === "string" && args.issueId.length > 0
        ? args.issueId
        : null
  if (args.issueId !== undefined && args.issueId !== null && issueIdArg === null) {
    return { ok: false, error: "issueId 必须是已有问题候选的 ID 字符串" }
  }

  // ② validate each evidence independently; any invalid → reject the whole
  // call (D4 fail-closed). Exception (AMENDMENT, live m01516): when EVERY
  // provided id is unresolvable in the host DB AND ACP-ref-shaped
  // (/^m\d{1,7}$/), fall back to the current turn's triggering user message.
  // Mixed valid/unresolvable, or unresolvable ids that are NOT m-ref-shaped,
  // stay a hard reject — no silent fallback for garbage.
  const ACP_REF_RE = /^m\d{1,7}$/
  const validated = []
  let unresolvableRef = null // {id, reason} when an ACP-shaped id was not found
  if (evidenceExplicit) {
    for (const id of evidenceIds) {
      const v = validateEvidence({ dbPath, messageId: id, currentProjectId: projectId })
      if (v.ok) {
        validated.push(v)
        continue
      }
      if (/does not exist in the host database/.test(v.reason) && ACP_REF_RE.test(id)) {
        unresolvableRef = { id, reason: v.reason }
        continue
      }
      return { ok: false, error: `evidence 校验失败 (${id}): ${v.reason}` }
    }
  }
  let evidenceVia = "explicit-ids"
  if (!evidenceExplicit || unresolvableRef !== null) {
    if (unresolvableRef !== null && validated.length > 0) {
      // mixed resolvable + unresolvable-ACP-ref → no fallback, hard reject
      return { ok: false, error: `evidence 校验失败 (${unresolvableRef.id}): ${unresolvableRef.reason}` }
    }
    const fb = findCurrentTurnUserMessage({ dbPath, sessionID })
    if (!fb.ok) return { ok: false, error: fb.reason }
    const v = validateEvidence({ dbPath, messageId: fb.messageId, currentProjectId: projectId })
    if (!v.ok) return { ok: false, error: `当前用户消息校验失败 (${fb.messageId}): ${v.reason}` }
    validated.length = 0
    validated.push(v)
    evidenceIds = [fb.messageId]
    evidenceVia = "current-turn-fallback"
  }

  // ③ issueId given → must exist AND belong to the current project; on
  // mismatch reject this call — never silently create a new issue (D3).
  let store = null
  if (issueIdArg !== null) {
    try {
      store = openStoreFor(cfg)
    } catch (err) {
      return { ok: false, error: storeOpenError(err) }
    }
    const issue = store.getIssue(issueIdArg) // throws (fail-closed) on damaged stores
    if (!issue) {
      return { ok: false, error: `issueId ${issueIdArg} 不存在 — 本次拒绝, 不静默新建 (D3)` }
    }
    if (issue.projectId !== projectId) {
      return { ok: false, error: `issueId ${issueIdArg} 属于其他项目 — 本次拒绝 (D3/D4)` }
    }
  }

  // Mock receipt (II.2): full-chain validation ran as usual, but nothing is
  // written to the store; the receipt goes to an isolated directory.
  if (cfg.mock) {
    writeMockReceipt(cfg.mockDir, {
      ts: Date.now(),
      mock: true,
      sessionId: sessionID,
      projectId,
      issueId: issueIdArg,
      evidence: evidenceIds,
      evidenceVia,
      description,
      topic,
      note: "mock 回执 — 未写入生产存储",
    })
    return {
      ack: true,
      mock: true,
      issueId: "MOCK",
      eventId: `MOCK-${randomBytes(4).toString("hex")}`,
      evidenceVia,
      note: "mock 回执: 校验已通过, 未写入任何存储",
    }
  }

  // ④ append events (idempotent by source sessionId+messageId). The first
  // evidence creates the draft candidate when no issueId was given; the rest
  // are appended to the same issue. Duplicates return the existing event
  // without writing (II.1 same-source idempotency).
  if (!store) {
    try {
      store = openStoreFor(cfg)
    } catch (err) {
      return { ok: false, error: storeOpenError(err) }
    }
  }
  let canonicalIssueId = issueIdArg
  let canonicalEventId = null
  let duplicate = false
  for (let i = 0; i < validated.length; i++) {
    const ev = validated[i]
    const res = store.appendEvent({
      source: { sessionId: ev.sessionId, projectId, messageId: evidenceIds[i] },
      evidence: { excerpt: ev.excerpt, messageRef: evidenceIds[i] },
      issueId: canonicalIssueId,
      title: description.slice(0, TITLE_MAX_CHARS),
      topic,
    })
    canonicalIssueId = canonicalIssueId ?? res.event.issueId
    if (canonicalEventId === null) canonicalEventId = res.event.id
    if (res.duplicate) duplicate = true
  }
  return {
    ack: true,
    issueId: canonicalIssueId,
    eventId: canonicalEventId,
    evidenceVia,
    ...(duplicate ? { duplicate: true } : {}),
    note: "已登记进入待审队列; 用户可通过 supervisor-memory CLI 的 digest 命令复核处理",
  }
}
