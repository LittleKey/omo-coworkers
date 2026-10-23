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
// Description lint (III.0): object semantics / effect / failure statements
// only. Amendment trail: initial text 2026-10-23; same day, translated to
// English (R26 three-part format, user request m01908) — semantics
// unchanged, no recorded corrections yet.
import { gateSession, openStoreFor, storeOpenError } from "./common.mjs"

export const MEMORY_STATUS_TOOL_NAME = "memory_status"

export const TOOL_DESCRIPTION =
  "Read-only view of the current project's memory state; no input. " +
  "Effect: returns the current project's and user-global active rules (id, one-line summary, status, version) plus pending candidate counts; contains no other projects' data and no approval-flow details. " +
  "Human review entry point: the supervisor-memory CLI digest command. " +
  "Failure: an uninitialized or unreadable store returns an explicit error; the database is never auto-created."

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

/** Never throws; every failure path returns {ok:false, error}. */
export async function executeMemoryStatus(rawArgs, context, { cfg }) {
  try {
    return await runMemoryStatus(context, { cfg })
  } catch (err) {
    return { ok: false, error: `memory_status 内部错误: ${err?.message ?? err}` }
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
  if (!gate.ok) return { ok: false, error: gate.error }
  const { projectId } = gate

  let store
  try {
    store = openStoreFor(cfg)
  } catch (err) {
    return { ok: false, error: storeOpenError(err) }
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
    note: "最小信息视图; 人审入口: supervisor-memory CLI 的 digest 命令",
  }
}
