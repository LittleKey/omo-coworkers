// draft_rule — model tool face, v6.0 design Part III step 1a (§III.1 row 2).
// Drafts a rule body for ONE existing issue candidate. Draft-state only:
// the write lands in the rebuildable drafts.json view via the SAME saveDraft
// function the CLI `digest --draft` path uses (cli/views.mjs) — one writer,
// no second JSON assembly, CLI and tool concurrent-safe by atomic tmp+rename.
// Produces no decision, no authorization, no status change; a later draft
// never affects an existing decision.
//
// Failure behavior is total: unknown issue / other project / non-draft issue
// / empty or over-limit body (≤10 lines, same cap as approve; oversize fails
// whole, never truncated) → the whole call is rejected.
//
// Description lint (III.0): every sentence is an object-semantics, input,
// effect, or failure statement. Amendment trail: initial text 2026-10-23,
// no recorded corrections yet.
import { countBodyLines, BODY_MAX_LINES } from "./cli/patch.mjs"
import { saveDraft } from "./cli/views.mjs"
import { gateSession, openStoreFor, storeOpenError, writeMockReceipt } from "./common.mjs"

export const DRAFT_TOOL_NAME = "draft_rule"

export const TOOL_DESCRIPTION =
  "为一个已存在的问题候选起草规则正文, 只写草稿态。" +
  "输入: issueId(候选 ID, 必须存在、属于当前项目且状态为 draft), body(规则正文, 上限 10 行)。" +
  "效果: 正文写入草稿视图(digest/drafts.json), 不产生任何批准、授权或状态变更; 草稿变更不影响已有决策。" +
  "失败行为: 候选不存在、属于其他项目、非 draft 状态或正文为空/超过 10 行时, 本次调用整体拒绝。"

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    issueId: {
      type: "string",
      description: "已有问题候选 ID; 必须存在、属于当前项目且状态为 draft",
    },
    body: {
      type: "string",
      description: "规则正文; 上限 10 行, 超行整体拒绝(不截断)",
    },
  },
  required: ["issueId", "body"],
  additionalProperties: false,
}

export function buildDraftRuleTool({ cfg }) {
  return {
    name: DRAFT_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input: INPUT_SCHEMA,
    options: { codemode: false },
    // Host tool convention (verified m1-p0): model-facing result must come
    // from result.content — same dual-form receipt as report_correction.
    execute: async (args, context) => {
      const res = await executeDraftRule(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

/** Never throws; every failure path returns {ok:false, error}. */
export async function executeDraftRule(rawArgs, context, { cfg }) {
  try {
    return await runDraftRule(rawArgs, context, { cfg })
  } catch (err) {
    return { ok: false, error: `draft_rule 内部错误: ${err?.message ?? err}` }
  }
}

async function runDraftRule(rawArgs, context, { cfg }) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {}

  // Session gate: root session only, project identity from the host DB
  // (shared helper — same discriminator as report_correction).
  const gate = gateSession(context, cfg)
  if (!gate.ok) return { ok: false, error: gate.error }
  const { sessionID, projectId } = gate

  const issueId = typeof args.issueId === "string" ? args.issueId.trim() : ""
  if (issueId.length === 0) {
    return { ok: false, error: "issueId 必须是已有问题候选的 ID 字符串" }
  }
  if (typeof args.body !== "string") {
    return { ok: false, error: "body 必须是规则正文字符串" }
  }
  // Same normalization as the CLI approve body path, so an approve can adopt
  // this draft verbatim.
  const body = args.body.replace(/\r\n/g, "\n").replace(/\s+$/, "")
  if (body.trim().length === 0) {
    return { ok: false, error: "拒绝: 正文为空" }
  }
  const lineCount = countBodyLines(body)
  if (lineCount > BODY_MAX_LINES) {
    return {
      ok: false,
      error: `拒绝: 正文 ${lineCount} 行超过 ${BODY_MAX_LINES} 行上限 — 整体拒绝, 不截断`,
    }
  }

  let store
  try {
    store = openStoreFor(cfg)
  } catch (err) {
    return { ok: false, error: storeOpenError(err) }
  }

  const issue = store.getIssue(issueId) // throws (fail-closed) on damaged stores
  if (!issue) {
    return { ok: false, error: `拒绝: 候选 ${issueId} 不存在` }
  }
  if (issue.projectId !== projectId) {
    return { ok: false, error: `拒绝: 候选 ${issueId} 属于其他项目` }
  }
  if (issue.status !== "draft") {
    return { ok: false, error: `拒绝: 候选 ${issueId} 状态为 ${issue.status}; 仅为 draft 候选起草` }
  }

  // Mock: full-chain validation ran as usual, but nothing is written.
  if (cfg.mock) {
    writeMockReceipt(cfg.mockDir, {
      ts: Date.now(),
      mock: true,
      tool: DRAFT_TOOL_NAME,
      sessionId: sessionID,
      projectId,
      issueId,
      lines: lineCount,
      note: "mock 回执 — 草稿未写入",
    })
    return {
      ack: true,
      mock: true,
      draftId: issueId,
      body,
      note: "mock 回执: 校验已通过, 草稿未写入任何存储",
    }
  }

  // The single shared writer (CLI digest --draft uses the same one).
  saveDraft(store.root, issueId, body, Date.now())
  return {
    ack: true,
    draftId: issueId,
    issueId,
    body,
    note: "草稿已存(digest/drafts.json 视图); 未批准、未生效, 等待人工 digest/approve",
  }
}
