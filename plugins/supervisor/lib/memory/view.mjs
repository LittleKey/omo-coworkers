// memory_status — read-only model tool face, v6.0 design Part III step 1a
// (§III.1 last row "只读状态视图"). No writes. Returns the CURRENT project's
// rules (host-DB session project identity, shared gate) plus user-global
// rules — the ones this session actually loads — as id/one-line
// summary/status/version, and the pending candidate queue of the CURRENT
// project (counts plus a capped item list). Minimal information: no other
// projects' data, no directory-scope rules (their subtree cannot be
// attributed from a tool execute context), no approval-flow details (no
// decision ids, targets, or hashes). The human review entry point is the
// supervisor-memory CLI digest command.
//
// R33 phase 1: the tool name keeps its memory_ prefix (it already had one);
// the description is the slim two-sentence form, and every failure returns
// the structured envelope {ok:false, code, message, nextTool, retry}.
//
// R33 phase 4: (a) the pending counts and the new pending item list are
// filtered to the session's project at the view layer — store.listPending()
// is store-wide by design, so counting it unfiltered leaked other projects'
// candidate counts; candidates are project-scoped objects (there are no
// user-global candidates), user-global RULES remain visible from every
// project. (b) pending carries a capped item list (id / one-line source
// excerpt / first-seen timestamp / draft-body status, ≤ 20 entries) so the
// model can see WHAT awaits review, not just how much. (c) an optional `id`
// argument (RUL-…/ISS-…) returns a `details` object for that one in-scope
// object — full rule body/scope/channel/version/status/agents, or the
// candidate's evidence excerpts/sources/draft status. The permission gate is
// unchanged (root session + this project + user-global rules); an
// out-of-scope id returns NOT_FOUND indistinguishable from an unknown id
// (existence never leaks across projects).
//
// Description lint (III.0, R33 form). Amendment trail: initial text
// 2026-10-23; same day, translated to English (R26 three-part format, user
// request m01908); R33 phase 1 slimmed it — semantics unchanged, no recorded
// corrections yet.
import { gateSession, memoryError, openStoreFor, sessionRejected, storeOpenError } from "./common.mjs"
import { readDrafts } from "./cli/views.mjs"

export const MEMORY_STATUS_TOOL_NAME = "memory_status"

export const TOOL_DESCRIPTION =
  "Inspect memory rules and pending candidates in the current scope, with optional per-ID details. Read-only."

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "Optional. Rule ID (RUL-…) or candidate ID (ISS-…); when present the reply adds a details object for that one in-scope object (out-of-scope ids return NOT_FOUND).",
    },
  },
  additionalProperties: false,
}

/** Hard cap on the pending item list (counts stay uncapped project totals). */
export const PENDING_ITEMS_MAX = 20

export function buildMemoryStatusTool({ cfg }) {
  return {
    name: MEMORY_STATUS_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input: INPUT_SCHEMA,
    options: { codemode: false },
    execute: async (args, context) => {
      const res = await executeMemoryStatus(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

/** Never throws; every failure path returns the structured envelope (R33). */
export async function executeMemoryStatus(rawArgs, context, { cfg }) {
  try {
    return await runMemoryStatus(rawArgs, context, { cfg })
  } catch (err) {
    return memoryError("INTERNAL", `memory_status internal error: ${err?.message ?? err} — report it; do not retry unchanged`)
  }
}

function oneLineSummary(body) {
  const line = String(body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  const s = line ?? ""
  return s.length > 100 ? `${s.slice(0, 99)}…` : s
}

/** The scopes a session may see: user-global rules, and its own project's. */
function inScope(scope, projectId) {
  return Boolean(scope && (scope.kind === "user-global" || (scope.kind === "project" && scope.projectId === projectId)))
}

/** Whether a draft rule text exists for this candidate (shared drafts.json view). */
function draftStatusOf(drafts, issueId) {
  return drafts.drafts[issueId]?.body ? "drafted" : "none"
}

/**
 * Per-ID details (R33 phase 4). Same permission gate as the list view: this
 * project's objects and user-global rules only. Returns null for unknown OR
 * out-of-scope ids — callers must not distinguish the two (existence never
 * leaks across projects; directory-scope rules are likewise NOT visible
 * here, their human entry point stays the CLI digest).
 */
function detailsForId(store, id, projectId) {
  if (id.startsWith("RUL-")) {
    const rule = store.getRule(id)
    if (!rule || !inScope(rule.scope, projectId)) return null
    return {
      kind: "rule",
      id: rule.id,
      status: rule.status,
      version: rule.version,
      body: rule.body,
      scope: rule.scope,
      channel: rule.channel ?? null,
      agents: rule.agents ?? null,
    }
  }
  const issue = store.getIssue(id)
  if (!issue || issue.projectId !== projectId) return null
  const events = store.listEvents({ issueId: id })
  const drafts = readDrafts(store.root)
  return {
    kind: "issue",
    id: issue.id,
    status: issue.status,
    title: issue.title,
    projectId: issue.projectId,
    recurrence: issue.recurrence ?? null,
    draftStatus: draftStatusOf(drafts, issue.id),
    evidence: events.map((e) => ({
      excerpt: oneLineSummary(e.evidence?.excerpt),
      ts: e.evidence?.ts ?? null,
      source: e.source ?? null,
    })),
  }
}

async function runMemoryStatus(rawArgs, context, { cfg }) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {}
  const gate = gateSession(context, cfg)
  if (!gate.ok) return sessionRejected(gate.error)
  const { projectId } = gate

  let store
  try {
    store = openStoreFor(cfg)
  } catch (err) {
    return storeOpenError(err)
  }

  // Optional per-ID details (validated before any lookup; the id argument
  // never bypasses the project gate above).
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (id.length > 128 || (id.length > 0 && !id.startsWith("RUL-") && !id.startsWith("ISS-"))) {
    return memoryError("INVALID_INPUT", "id must be a rule ID (RUL-…) or a candidate ID (ISS-…)")
  }
  let details = null
  if (id.length > 0) {
    details = detailsForId(store, id, projectId)
    if (!details) {
      return memoryError(
        "NOT_FOUND",
        `${id} is not visible in this scope — rules and candidates are project-scoped (user-global rules are visible everywhere) and out-of-scope ids are never distinguished from unknown ones; find IDs via the supervisor-memory CLI digest`,
      )
    }
  }

  // Current project + user-global (this session loads both); directory-scope
  // rules are NOT attributable from here and are never another project's
  // leak vector to expose — they stay visible via the human CLI digest.
  const rules = store
    .listRules()
    .filter((r) => inScope(r.scope, projectId))
    .map((r) => ({
      id: r.id,
      summary: oneLineSummary(r.body),
      status: r.status,
      version: r.version,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // Pending queue, filtered to the session's project at the view layer
  // (store.listPending() is store-wide by design). Candidates are
  // project-scoped objects — there is no user-global candidate kind — so a
  // session sees exactly its own project's queue. Counts are uncapped
  // project totals; the item list is capped at PENDING_ITEMS_MAX,
  // most-recently-active first.
  const pending = store.listPending()
  const projIssues = pending.issues.filter((i) => i.projectId === projectId)
  const projEvents = pending.events.filter((e) => e.source?.projectId === projectId)
  const drafts = readDrafts(store.root)
  const excerptOf = (issue) => {
    const ev = projEvents.find((e) => e.issueId === issue.id)
    return oneLineSummary(ev?.evidence?.excerpt ?? issue.title)
  }
  const items = projIssues
    .slice()
    .sort((a, b) => (b.lastEventAtTs ?? 0) - (a.lastEventAtTs ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, PENDING_ITEMS_MAX)
    .map((i) => ({
      id: i.id,
      excerpt: excerptOf(i),
      firstSeenTs: i.createdAtTs ?? null,
      draftStatus: draftStatusOf(drafts, i.id),
    }))

  return {
    ok: true,
    projectId,
    rules,
    pending: { candidates: projIssues.length, events: projEvents.length, items },
    ...(details ? { details } : {}),
    note: "minimal information view; human-review entry point: the supervisor-memory CLI digest command",
  }
}
