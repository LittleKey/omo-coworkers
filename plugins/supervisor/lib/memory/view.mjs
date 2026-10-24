// memory_status — read-only model tool face, v6.0 design Part III step 1a
// (§III.1 last row "只读状态视图"). No input, zero writes. Returns the
// CURRENT project's rules (host-DB session project identity, shared gate)
// plus user-global rules — the ones this session actually loads — as
// id/one-line summary/status/version, and the pending candidate counts.
// Minimal information: no other projects' data, no directory-scope rules
// (their subtree cannot be attributed from a tool execute context), no
// approval-flow details (no decision ids, targets, or hashes). The human
// review entry point is the supervisor-memory CLI digest command.
//
// R33 phase 1: the tool name keeps its memory_ prefix (it already had one);
// the description is the slim two-sentence form, and every failure returns
// the structured envelope {ok:false, code, message, nextTool, retry}.
//
// Description lint (III.0, R33 form). Amendment trail: initial text
// 2026-10-23; same day, translated to English (R26 three-part format, user
// request m01908); R33 phase 1 slimmed it — semantics unchanged, no recorded
// corrections yet.
import { gateSession, memoryError, openStoreFor, sessionRejected, storeOpenError } from "./common.mjs"

export const MEMORY_STATUS_TOOL_NAME = "memory_status"

export const TOOL_DESCRIPTION =
  "Inspect memory rules and pending candidates in the current scope. Read-only."

const INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false }

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
    return await runMemoryStatus(context, { cfg })
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

async function runMemoryStatus(_context, { cfg }) {
  const gate = gateSession(_context, cfg)
  if (!gate.ok) return sessionRejected(gate.error)
  const { projectId } = gate

  let store
  try {
    store = openStoreFor(cfg)
  } catch (err) {
    return storeOpenError(err)
  }

  // Current project + user-global (this session loads both); directory-scope
  // rules are NOT attributable from here and are never another project's
  // leak vector to expose — they stay visible via the human CLI digest.
  const rules = store
    .listRules()
    .filter((r) => r.scope && (r.scope.kind === "user-global" || (r.scope.kind === "project" && r.scope.projectId === projectId)))
    .map((r) => ({
      id: r.id,
      summary: oneLineSummary(r.body),
      status: r.status,
      version: r.version,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const pending = store.listPending()
  return {
    ok: true,
    projectId,
    rules,
    pending: { candidates: pending.issues.length, events: pending.events.length },
    note: "minimal information view; human-review entry point: the supervisor-memory CLI digest command",
  }
}
