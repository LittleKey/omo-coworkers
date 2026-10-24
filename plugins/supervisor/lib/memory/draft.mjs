// memory_draft_rule (named draft_rule before the Oracle R33 tool-face
// phase 1 rename) — model tool face, v6.0 design Part III step 1a (§III.1
// row 2). Drafts a rule body for ONE existing issue candidate. Draft-state
// only: the write lands in the rebuildable drafts.json view via the SAME
// saveDraft function the CLI `digest --draft` path uses (cli/views.mjs) —
// one writer, no second JSON assembly, CLI and tool concurrent-safe by
// atomic tmp+rename. Produces no decision, no authorization, no status
// change; a later draft never affects an existing decision.
//
// Failure behavior is total: unknown issue / other project / non-draft issue
// / empty or over-limit body (≤10 lines, same cap as approve; oversize fails
// whole, never truncated) → the whole call is rejected with the structured
// error envelope (R33): {ok:false, code, message, nextTool, retry}.
//
// Description lint (III.0, R33 form): one or two sentences — usage + the key
// "not what"; parameter detail lives in the schema. Amendment trail: initial
// text 2026-10-23; same day, translated to English (R26 three-part format,
// user request m01908); R33 phase 1 slimmed it — semantics unchanged, no
// recorded corrections.
import { countBodyLines, BODY_MAX_LINES } from "./cli/patch.mjs"
import { saveDraft } from "./cli/views.mjs"
import { gateSession, mapStoreError, memoryError, openStoreFor, sessionRejected, storeOpenError, writeMockReceipt } from "./common.mjs"

export const DRAFT_TOOL_NAME = "memory_draft_rule"

export const TOOL_DESCRIPTION =
  "Save a rule body for an existing draft candidate. Changes draft state only."

// Drafting guidance appended to every body-parameter description (draft +
// approve). Guidance only — no validator enforces it and nothing is ever
// auto-deleted; it steers the drafting style toward human-readable rules.
export const BODY_DRAFTING_GUIDANCE =
  "正文优先使用用户可直接阅读的自然语言或简洁 Markdown。工具名、参数名和调用示例仅在表达规则所必需时保留；不要复制整段工具调用封装、回执 JSON 或与执行无关的字段。保留必要技术标识，避免无必要的中英文混写。"

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    issueId: {
      type: "string",
      description: "Required. Existing issue candidate ID; must exist, belong to the current project, and have draft status.",
    },
    body: {
      type: "string",
      description: `Required. Rule body text; max 10 lines — an oversize body rejects the whole call (never truncated). ${BODY_DRAFTING_GUIDANCE}`,
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
    // from result.content — same dual-form receipt as memory_record_correction.
    execute: async (args, context) => {
      const res = await executeDraftRule(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

/** Never throws; every failure path returns the structured envelope (R33). */
export async function executeDraftRule(rawArgs, context, { cfg }) {
  try {
    return await runDraftRule(rawArgs, context, { cfg })
  } catch (err) {
    return memoryError("INTERNAL", `memory_draft_rule internal error: ${err?.message ?? err} — report it; do not retry unchanged`)
  }
}

async function runDraftRule(rawArgs, context, { cfg }) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {}

  // Session gate: root session only, project identity from the host DB
  // (shared helper — same discriminator as memory_record_correction).
  const gate = gateSession(context, cfg)
  if (!gate.ok) return sessionRejected(gate.error)
  const { sessionID, projectId } = gate

  const issueId = typeof args.issueId === "string" ? args.issueId.trim() : ""
  if (issueId.length === 0) {
    return memoryError("INVALID_INPUT", "issueId must be a string ID of an existing issue candidate")
  }
  if (typeof args.body !== "string") {
    return memoryError("INVALID_INPUT", "body must be a rule body string")
  }
  // Same normalization as the CLI approve body path, so an approve can adopt
  // this draft verbatim.
  const body = args.body.replace(/\r\n/g, "\n").replace(/\s+$/, "")
  if (body.trim().length === 0) {
    return memoryError("INVALID_INPUT", `body is empty — provide a non-empty rule body (max ${BODY_MAX_LINES} lines)`)
  }
  const lineCount = countBodyLines(body)
  if (lineCount > BODY_MAX_LINES) {
    return memoryError(
      "INVALID_INPUT",
      `body is ${lineCount} lines, over the ${BODY_MAX_LINES}-line limit — rejected as a whole, never truncated`,
    )
  }

  let store
  try {
    store = openStoreFor(cfg)
  } catch (err) {
    return storeOpenError(err)
  }

  let issue
  try {
    issue = store.getIssue(issueId) // throws (fail-closed) on damaged stores
  } catch (err) {
    return mapStoreError(err)
  }
  if (!issue) {
    return memoryError("ISSUE_NOT_FOUND", `issue candidate ${issueId} does not exist in the store — check the ID via the supervisor-memory CLI digest`)
  }
  if (issue.projectId !== projectId) {
    return memoryError("ISSUE_FOREIGN", `issue candidate ${issueId} belongs to another project — rejected (D3/D4)`)
  }
  if (issue.status !== "draft") {
    return memoryError("NOT_DRAFTABLE", `issue candidate ${issueId} has status ${issue.status}; only draft candidates accept rule drafts`)
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
      note: "mock receipt — draft not written",
    })
    return {
      ack: true,
      mock: true,
      draftId: issueId,
      body,
      note: "mock receipt: validation ran fully, draft written to no store",
    }
  }

  // The single shared writer (CLI digest --draft uses the same one).
  saveDraft(store.root, issueId, body, Date.now())
  return {
    ack: true,
    draftId: issueId,
    issueId,
    body,
    note: "draft saved (digest/drafts.json view); not approved, not in effect, awaiting manual digest/approve",
  }
}
