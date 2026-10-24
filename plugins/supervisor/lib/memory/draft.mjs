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
// effect, or failure statement. Amendment trail: initial text 2026-10-23;
// same day, translated to English (R26 three-part format, user request
// m01908) — semantics unchanged, no recorded corrections.
import { countBodyLines, BODY_MAX_LINES } from "./cli/patch.mjs"
import { saveDraft } from "./cli/views.mjs"
import { gateSession, openStoreFor, storeOpenError, writeMockReceipt } from "./common.mjs"

export const DRAFT_TOOL_NAME = "draft_rule"

export const TOOL_DESCRIPTION =
  "Drafts a rule body for one existing issue candidate; writes draft state only. " +
  "Input: issueId (must exist, belong to the current project, and have draft status) and body (rule text, max 10 lines). " +
  "Effect: the body lands in the draft view (digest/drafts.json); produces no approval, authorization, or status change; draft changes never affect existing decisions. " +
  "Failure: unknown issue, other project's issue, non-draft status, or an empty/over-10-line body rejects the whole call."

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    issueId: {
      type: "string",
      description: "Existing issue candidate ID; must exist, belong to the current project, and have draft status",
    },
    body: {
      type: "string",
      description: "Rule body text; max 10 lines — an oversize body rejects the whole call (never truncated)",
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
    return { ok: false, error: `draft_rule internal error: ${err?.message ?? err}` }
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
    return { ok: false, error: "issueId must be a string ID of an existing issue candidate" }
  }
  if (typeof args.body !== "string") {
    return { ok: false, error: "body must be a rule body string" }
  }
  // Same normalization as the CLI approve body path, so an approve can adopt
  // this draft verbatim.
  const body = args.body.replace(/\r\n/g, "\n").replace(/\s+$/, "")
  if (body.trim().length === 0) {
    return { ok: false, error: "rejected: body is empty" }
  }
  const lineCount = countBodyLines(body)
  if (lineCount > BODY_MAX_LINES) {
    return {
      ok: false,
      error: `rejected: body is ${lineCount} lines, over the ${BODY_MAX_LINES}-line limit — rejected as a whole, never truncated`,
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
    return { ok: false, error: `rejected: issue candidate ${issueId} does not exist in the store` }
  }
  if (issue.projectId !== projectId) {
    return { ok: false, error: `rejected: issue candidate ${issueId} belongs to another project` }
  }
  if (issue.status !== "draft") {
    return { ok: false, error: `rejected: issue candidate ${issueId} has status ${issue.status}; only draft candidates accept rule drafts` }
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
