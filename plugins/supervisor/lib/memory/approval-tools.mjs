// Memory approval / delivery tool face (Oracle R33+ phase 3, Bridge A only).
//
// Four tools, registered together with the rest of the memory face behind the
// single memory.enable switch (tool.mjs buildMemoryTools):
//
//   memory_approve_rule     — record the user's rule approval (new rule or new
//                             version). Confirmation ONLY through a hosted
//                             single-choice Confirm/Cancel form (Bridge A):
//                             the plugin creates the form bound to the frozen
//                             object + display-time store snapshot, blocks on
//                             the answer, and consumes it exactly once. The
//                             model can never provide `confirmed`/an answer/
//                             a hash/"the user agreed" — such arguments are a
//                             hard reject, and the schema has no such field.
//   memory_enable_delivery  — record the user's system-ride delivery
//                             authorization for one CURRENT rule version,
//                             binding the quadruple
//                             (ruleId, version, bodyHash, channel). Separate
//                             from approval: approval ≠ delivery ≠ applied.
//                             Same form flow. On a disabled rule it refuses —
//                             re-enabling means "re-enable + approve as a NEW
//                             version" (fresh full approval, never a delivery
//                             switch, never a reuse of the old authorization).
//   memory_disable_delivery — stop-class. Records the stop-appending decision
//                             IMMEDIATELY: no second confirmation form under
//                             an explicit admin request (adjudication; bug ③
//                             parity with the CLI). Identity/scope validation
//                             (root session) is kept.
//   memory_disable_rule     — stop-class. Disables the rule in the store; no
//                             second confirmation form; root-session gate kept.
//
// The form deadline is enforced BEFORE an answered state is accepted
// (confirm.mjs), the answer feeds exactly one decision (consume-once), and
// every submit goes through approval-service.submitDecision — the same
// short cross-process critical section the CLI uses (bug ① TOCTOU fix). A
// decision recorded but followed by a later failure ALWAYS surfaces its
// decisionId so a retry can never record a duplicate approval.
//
// Same-UID impersonation is an accepted residual risk: this face never
// claims to prove the answerer is a human — only that the answer came from
// the session's hosted form.

import fs from "node:fs"

import { countBodyLines, BODY_MAX_LINES, generatePatch } from "./cli/patch.mjs"
import { deriveDeliveryState, rideBodyHash, RIDE_CHANNEL } from "./ride.mjs"
import { canonicalJson, sha256Hex } from "./store.mjs"
import {
  gateSession,
  mapStoreError,
  memoryError,
  openStoreFor,
  sessionRejected,
  storeOpenError,
} from "./common.mjs"
import {
  ApprovalConflictError,
  ApprovalStaleError,
  snapshotState,
  submitDecision,
} from "./approval-service.mjs"
import {
  buildApprovalDisplay,
  clampConfirmTimeoutMin,
  CONFIRM_VALUE,
  createConfirmBridge,
  requireAbsoluteTarget,
  resolveHostApi,
} from "./confirm.mjs"

const REVIEW_DEFAULT_DAYS = 30
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Keys a model may pass to TRY to fake a confirmation. Present anywhere in
// the args → hard reject (fail-closed; the schema also has no such fields).
const FORBIDDEN_ARG_KEYS = [
  "confirmed",
  "confirm",
  "approved",
  "answer",
  "userAgreed",
  "user_agreed",
  "agreed",
  "hash",
  "objectHash",
  "bodyHash",
  "decisionId",
  "formId",
  "formID",
]

function rejectForgedConfirmation(args) {
  for (const k of FORBIDDEN_ARG_KEYS) {
    if (args[k] !== undefined) {
      return memoryError(
        "INVALID_INPUT",
        `"${k}" is not an acceptable argument: the model can never provide confirmation artifacts (an answer, a hash, "the user agreed"). The only confirmation source is the hosted single-choice form this tool creates and the host's recorded answer.`,
      )
    }
  }
  return null
}

function scopeDescriptionOf(scope, projectId) {
  if (scope.kind === "user-global") return "user-global — global ~/.config/opencode/AGENTS.md (loaded by all projects)"
  if (scope.kind === "project") return `project — the root AGENTS.md of project ${scope.projectId ?? projectId} (confirmed directory)`
  return `directory — the AGENTS.md of the ${scope.directory} subtree (loaded only by sessions inside that directory)`
}

/** Best-effort append-only audit trail next to the store (extra files do not affect store health). */
function appendAudit(store, entry) {
  try {
    fs.appendFileSync(`${store.root}/approval-audit.jsonl`, JSON.stringify(entry) + "\n", { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function auditOutcome(store, base, outcome, extra = {}) {
  const ok = appendAudit(store, { ts: Date.now(), outcome, ...base, ...extra })
  return ok ? {} : { auditWarning: "approval-audit.jsonl append failed (decision state is unaffected)" }
}

/** Map a submitDecision failure to its structured envelope; rethrows unknown errors. */
function submitErrorEnvelope(e) {
  if (e instanceof ApprovalStaleError) {
    return memoryError(
      "CONFIRMATION_STALE",
      `${e.message} Each retry is a brand-new decision behind a brand-new form — rebuild the arguments from the CURRENT store state first; never resubmit the stale display.`,
      { retry: "safe" },
    )
  }
  if (e instanceof ApprovalConflictError) {
    return memoryError("APPROVAL_BUSY", e.message, { retry: "safe" })
  }
  if (e instanceof Error && typeof e.code === "string" && e.code.startsWith("MEMORY_FORM")) {
    return memoryError("FORM_ERROR", `${e.message} — nothing recorded; retry creates a fresh form`, { retry: "safe" })
  }
  if (e instanceof Error && e.code === "MEMORY_CONFIRMATION_REPLAY") {
    return memoryError("CONFIRMATION_REPLAY", e.message, { retry: "never" })
  }
  const mapped = mapStoreError(e) // returns envelope for StoreError, rethrows otherwise
  return mapped
}

function openStoreGated(cfg) {
  try {
    const store = openStoreFor(cfg)
    store.requireHealthy() // D5: authorization outputs stay closed on unhealthy stores
    return { ok: true, store }
  } catch (err) {
    return { ok: false, error: storeOpenError(err) }
  }
}

async function buildBridge(cfg) {
  const c = cfg.confirm ?? {}
  const api = await resolveHostApi({ env: c.env ?? process.env, readFile: c.readFile })
  if (!api) return { ok: false }
  return {
    ok: true,
    bridge: createConfirmBridge({
      base: api.base,
      authHeader: api.authHeader,
      fetchImpl: c.fetchImpl ?? globalThis.fetch,
      pollMs: c.pollMs ?? 250,
      httpTimeoutMs: c.httpTimeoutMs ?? 5000,
      now: c.now,
    }),
  }
}

const CONFIRM_UNAVAILABLE_MSG =
  "no opencode host form API is reachable (service.json not found or unresolvable) — a confirmation form cannot be created, so NOTHING is approved. Fallback: ask the user to run the supervisor-memory CLI approve / delivery-enable command in a terminal."

/**
 * Shared Bridge A confirmation flow for the two confirm-class tools:
 * snapshot → create form (full display, single choice) → block → deadline-
 * guarded answer → consume-once → answer envelope. Every terminal outcome is
 * audited. Returns {ok:true, formID} or {ok:false, error} (structured).
 */
async function runConfirmation({ store, cfg, sessionID, signal, kind, title, display, objectHash, snapshot, snapshotHash, deadlineTs, deadlineMin }) {
  const auditBase = { tool: kind, sessionID, formID: null, objectHash, snapshotHash, deadlineTs }
  const b = await buildBridge(cfg)
  if (!b.ok) {
    return { ok: false, error: memoryError("CONFIRMATION_UNAVAILABLE", CONFIRM_UNAVAILABLE_MSG, { retry: "safe" }) }
  }
  const { bridge } = b
  let formID = null
  try {
    const created = await bridge.createForm({ sessionID, title, display, objectHash, kind })
    formID = created.formID
  } catch (e) {
    return {
      ok: false,
      error: memoryError("FORM_ERROR", `${e?.message ?? e} — nothing recorded; retry creates a fresh form`, { retry: "safe" }),
    }
  }
  auditBase.formID = formID
  const cleanupListener = (handler) => {
    if (signal && handler) signal.removeEventListener("abort", handler)
  }
  try {
    // Block on the answer; a host session abort (signal) races the wait so a
    // cancelled request neither lingers nor leaves a stray pending form.
    let abortHandler = null
    const abortP = signal
      ? new Promise((resolveAbort) => {
          abortHandler = () => resolveAbort("aborted")
          signal.addEventListener("abort", abortHandler, { once: true })
        })
      : null
    let r
    try {
      r = abortP ? await Promise.race([bridge.waitAnswer({ sessionID, formID, deadlineTs }), abortP]) : await bridge.waitAnswer({ sessionID, formID, deadlineTs })
    } finally {
      cleanupListener(abortHandler)
    }
    if (r === "aborted") {
      await bridge.cancelForm(sessionID, formID)
      return {
        ok: false,
        error: memoryError(
          "CONFIRMATION_CANCELLED",
          "the host session aborted the request — the pending form was cancelled and nothing was recorded; a retry needs a fresh form and a fresh decision",
          { retry: "requires_user_confirmation" },
        ),
      }
    }
    if (r.status === "answered") {
      bridge.consume(formID) // consume-once: this form can never feed a second decision
      const choice = r.answer?.choice
      if (choice === CONFIRM_VALUE) return { ok: true, formID, answer: r.answer, auditBase }
      if (choice === "cancel") {
        return {
          ok: false,
          error: memoryError(
            "CONFIRMATION_CANCELLED",
            "the user chose Cancel on the confirmation form — nothing was recorded; do not retry unless the user explicitly asks again",
            { retry: "requires_user_confirmation" },
          ),
        }
      }
      return {
        ok: false,
        error: memoryError("CONFIRMATION_INVALID", `the form answer "${String(choice)}" is neither confirm nor cancel — refusing (fail-closed)`, { retry: "safe" }),
      }
    }
    if (r.status === "cancelled") {
      return {
        ok: false,
        error: memoryError(
          "CONFIRMATION_CANCELLED",
          "the confirmation form was cancelled (user or session teardown) — nothing was recorded; a retry requires a fresh form and a fresh decision",
          { retry: "requires_user_confirmation" },
        ),
      }
    }
    // expired: deadline passed (checked before the answer was accepted), form deleted locally
    return {
      ok: false,
      error: memoryError(
        "CONFIRMATION_EXPIRED",
        `the confirmation form expired unanswered after ${deadlineMin} minutes (${r.cleanup}) — nothing was recorded; retry re-asks the user with a fresh form`,
        { retry: "safe" },
      ),
    }
  } catch (e) {
    if (e?.code === "MEMORY_CONFIRMATION_STALE") {
      return {
        ok: false,
        error: memoryError(
          "CONFIRMATION_STALE",
          `${e.message} — nothing recorded; a retry creates a brand-new form and a brand-new decision`,
          { retry: "safe" },
        ),
      }
    }
    return { ok: false, error: memoryError("FORM_ERROR", `${e?.message ?? e} — nothing recorded`, { retry: "safe" }) }
  } finally {
    // Session aborted while blocked: cancel the pending form so no stray
    // prompt survives; the outcome error is produced by the caller via signal.
    if (signal?.aborted) await bridge.cancelForm(sessionID, formID)
  }
}

// ═══════════════════════ memory_approve_rule ═══════════════════════

export const APPROVE_TOOL_NAME = "memory_approve_rule"

export const APPROVE_TOOL_DESCRIPTION =
  "Record the user's approval of a rule (new rule, or a new version of an existing rule) after the user confirms it on a hosted single-choice Confirm/Cancel form that displays the full object; blocks until answered. " +
  "Approval is a decision record only — it never delivers, never writes any file, and the model cannot supply or stand in for the confirmation."

const APPROVE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    issueId: {
      type: "string",
      description: "Approve a draft candidate into a NEW rule; must exist, belong to the current project, and have draft status. Exactly one of issueId/ruleId.",
    },
    ruleId: {
      type: "string",
      description: "Approve a NEW VERSION of an existing rule; must exist and not be disabled. Exactly one of issueId/ruleId.",
    },
    body: {
      type: "string",
      description: `Required. The full rule body text; max ${BODY_MAX_LINES} lines — an oversize body rejects the whole call (never truncated).`,
    },
    scope: {
      type: "object",
      description: "Required. Effective scope: {kind:\"project\"} (the current project), {kind:\"user-global\"}, or {kind:\"directory\", directory:\"<absolute path>\"}.",
      properties: {
        kind: { type: "string", enum: ["project", "user-global", "directory"] },
        directory: { type: "string", description: "Absolute path; required when kind is \"directory\"." },
      },
      required: ["kind"],
    },
    channel: {
      type: "string",
      enum: ["patch-human-apply", "system-ride"],
      description:
        "Required. patch-human-apply: patches for manual application. system-ride: persistent system-prompt injection across sessions — delivery is a SEPARATE authorization (memory_enable_delivery).",
    },
    targets: {
      type: "array",
      items: { type: "string" },
      description: "patch-human-apply only: absolute target file paths (must exist; new files are never created). Must be empty for system-ride.",
    },
    agents: {
      type: "array",
      items: { type: "string" },
      description: "system-ride only: restrict delivery to these agent names (literal match). Not allowed on patch-human-apply (cannot be honored).",
    },
    reviewDate: {
      type: "string",
      description: "Optional review date YYYY-MM-DD (default: 30 days from now).",
    },
    confirmTimeoutMin: {
      type: "number",
      description: "Optional minutes to wait for the form answer (1–30, default 10).",
    },
  },
  required: ["body", "scope", "channel"],
  additionalProperties: false,
}

export function buildApproveRuleTool({ cfg }) {
  return {
    name: APPROVE_TOOL_NAME,
    description: APPROVE_TOOL_DESCRIPTION,
    input: APPROVE_INPUT_SCHEMA,
    options: { codemode: false },
    execute: async (args, context) => {
      const res = await executeApproveRule(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

/** Never throws; every failure path returns the structured envelope (R33). */
export async function executeApproveRule(rawArgs, context, { cfg }) {
  try {
    return await runApproveRule(rawArgs, context, { cfg })
  } catch (err) {
    return memoryError("INTERNAL", `memory_approve_rule internal error: ${err?.message ?? err} — report it; do not retry unchanged`)
  }
}

async function runApproveRule(rawArgs, context, { cfg }) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {}
  const forged = rejectForgedConfirmation(args)
  if (forged) return forged

  const gate = gateSession(context, cfg)
  if (!gate.ok) return sessionRejected(gate.error)
  const { sessionID, projectId } = gate

  // ---- argument shape (mirror of the CLI's stage-1 refuses) ----
  const issueId = typeof args.issueId === "string" && args.issueId.length > 0 ? args.issueId : null
  const ruleId = typeof args.ruleId === "string" && args.ruleId.length > 0 ? args.ruleId : null
  if (issueId && ruleId) {
    return memoryError("INVALID_INPUT", "pass exactly one of issueId (approve a draft candidate as a new rule) or ruleId (approve a new version of an existing rule)")
  }
  if (!issueId && !ruleId) {
    return memoryError("INVALID_INPUT", "pass issueId (approve a draft candidate as a new rule) or ruleId (approve a new version of an existing rule)")
  }
  if (typeof args.body !== "string") return memoryError("INVALID_INPUT", "body must be a rule body string")
  const body = args.body.replace(/\r\n/g, "\n").replace(/\s+$/, "")
  if (body.trim().length === 0) return memoryError("INVALID_INPUT", `body is empty — provide a non-empty rule body (max ${BODY_MAX_LINES} lines)`)
  const lineCount = countBodyLines(body)
  if (lineCount > BODY_MAX_LINES) {
    return memoryError("INVALID_INPUT", `body is ${lineCount} lines, over the ${BODY_MAX_LINES}-line limit — rejected as a whole, never truncated`)
  }
  const scopeArg = args.scope && typeof args.scope === "object" && !Array.isArray(args.scope) ? args.scope : null
  if (!scopeArg) return memoryError("INVALID_INPUT", 'scope is required: {kind:"project"} | {kind:"user-global"} | {kind:"directory", directory:"<absolute path>"}')
  const scopeKind = scopeArg.kind
  let scope
  if (scopeKind === "project") {
    scope = { kind: "project", projectId }
  } else if (scopeKind === "user-global") {
    scope = { kind: "user-global" }
  } else if (scopeKind === "directory") {
    const dir = requireAbsoluteTarget(scopeArg.directory)
    if (!dir) return memoryError("INVALID_INPUT", 'scope.kind "directory" requires scope.directory as an absolute path')
    scope = { kind: "directory", directory: dir }
  } else {
    return memoryError("INVALID_INPUT", 'scope.kind must be "project", "user-global" or "directory"')
  }
  const channel = args.channel
  if (channel !== "patch-human-apply" && channel !== "system-ride") {
    return memoryError("INVALID_INPUT", 'channel must be "patch-human-apply" or "system-ride"')
  }
  let targets = []
  if (args.targets !== undefined && args.targets !== null) {
    if (!Array.isArray(args.targets) || !args.targets.every((t) => typeof t === "string")) {
      return memoryError("INVALID_INPUT", "targets must be an array of absolute file paths")
    }
    targets = args.targets
  }
  let agents = null
  if (args.agents !== undefined && args.agents !== null) {
    if (!Array.isArray(args.agents) || !args.agents.every((a) => typeof a === "string" && a.length > 0)) {
      return memoryError("INVALID_INPUT", "agents must be an array of non-empty agent-name strings")
    }
    agents = args.agents
  }
  if (channel === "patch-human-apply") {
    if (targets.length === 0) {
      return memoryError("INVALID_INPUT", 'channel "patch-human-apply" requires at least one existing absolute target path (new files are never created); use "system-ride" for a rule without static targets')
    }
    if (agents && agents.length > 0) {
      return memoryError(
        "AGENTS_SCOPE_UNHONORABLE",
        'agent restrictions cannot be honored through the AGENTS.md load scope (loads by directory, does not distinguish agents); to bind agents approve on the "system-ride" channel instead',
      )
    }
    for (const t of targets) {
      const abs = requireAbsoluteTarget(t)
      if (!abs) return memoryError("TARGET_INVALID", `target "${t}" is not an absolute path`)
      let st = null
      try {
        st = fs.statSync(abs)
      } catch {
        st = null
      }
      if (!st?.isFile()) {
        return memoryError("TARGET_INVALID", `target ${abs} does not exist as a file — new files are never created; missing targets refuse the whole call`)
      }
    }
    targets = targets.map((t) => requireAbsoluteTarget(t))
  } else {
    if (targets.length > 0) {
      return memoryError("INVALID_INPUT", 'channel "system-ride" produces no static targets — omit targets (the plugin never writes files for this channel)')
    }
    if (scope.kind === "directory") {
      return memoryError("SCOPE_RIDE_MISMATCH", 'system-ride matches sessions by project (or user-global); a directory scope cannot be matched — approve with project or user-global scope instead')
    }
  }
  let reviewDate = typeof args.reviewDate === "string" ? args.reviewDate.trim() : ""
  if (reviewDate === "") {
    reviewDate = new Date(Date.now() + REVIEW_DEFAULT_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
  } else if (!DATE_RE.test(reviewDate)) {
    return memoryError("INVALID_INPUT", "reviewDate must be YYYY-MM-DD")
  }
  const deadlineMin = clampConfirmTimeoutMin(args.confirmTimeoutMin ?? cfg.confirmTimeoutMin)

  // ---- store + subject checks (same refusals as the CLI) ----
  const opened = openStoreGated(cfg)
  if (!opened.ok) return opened.error
  const store = opened.store

  let issue = null
  let rule = null
  if (ruleId) {
    try {
      rule = store.getRule(ruleId)
    } catch (err) {
      return mapStoreError(err)
    }
    if (!rule) return memoryError("RULE_NOT_FOUND", `rule ${ruleId} does not exist in the store — check the ID via the supervisor-memory CLI status`)
    if (rule.status === "disabled") {
      return memoryError(
        "RULE_DISABLED",
        `rule ${ruleId} is disabled. Disabling is a human decision; re-enabling requires a fresh approval as a new version (enable flow) and can never be silently revived by approve`,
      )
    }
    if (rule.channel && rule.channel !== channel) {
      return memoryError("CHANNEL_SWITCH", `rule ${ruleId} was approved on channel ${rule.channel} — one rule one channel; re-approval cannot switch channels`)
    }
  } else {
    try {
      issue = store.getIssue(issueId)
    } catch (err) {
      return mapStoreError(err)
    }
    if (!issue) return memoryError("ISSUE_NOT_FOUND", `issue candidate ${issueId} does not exist in the store — check the ID via the supervisor-memory CLI digest`)
    if (issue.projectId !== projectId) return memoryError("ISSUE_FOREIGN", `issue candidate ${issueId} belongs to another project — rejected (D3/D4)`)
    if (issue.status !== "draft") {
      return memoryError(
        "NOT_DRAFTABLE",
        `issue candidate ${issueId} has status ${issue.status}; only draft candidates can be approved (a re-approve never restores or expands authorization)`,
      )
    }
  }

  // ---- frozen object + full display (BEFORE any choice) ----
  const object = {
    body,
    scope,
    targets,
    reviewDate,
    channel,
    directoryBoundary: scope.kind === "directory" ? scope.directory : null,
    agents: channel === "system-ride" && agents && agents.length > 0 ? agents : null,
  }
  const objectHash = sha256Hex(canonicalJson(object))
  const auditRuleId = rule?.id ?? null
  const display = buildApprovalDisplay({
    headline: `supervisor-memory approval — ${rule ? `${rule.id} → new version v${rule.version + 1}` : `new rule (from candidate ${issue.id}: ${issue.title})`}`,
    body,
    scopeDescription: scopeDescriptionOf(scope, projectId),
    channel,
    agents,
    targets: channel === "patch-human-apply" ? targets : [],
    reviewDate,
    objectHash,
    deadlineTs: 0, // replaced below with the real deadline
    extraLines: [
      channel === "system-ride"
        ? "this approval alone does NOT enable delivery — after approval the user must separately run memory_enable_delivery."
        : "this approval does NOT write any file — patches for manual application are produced separately (memory_prepare_publish / CLI approve output).",
    ],
  })

  // Display-time snapshot: captured BEFORE the form exists; the critical
  // section re-verifies it right before recording (bug ① fix).
  const snapshot = snapshotState(store, { ruleId: auditRuleId, issueId: issue?.id ?? null })
  const snapshotHash = sha256Hex(canonicalJson(snapshot))

  const deadlineTs = Date.now() + deadlineMin * 60_000
  const fullDisplay = `${display}\ndeadline: unanswered requests expire at ${new Date(deadlineTs).toISOString()} and record nothing.`

  // ---- Bridge A: create form → block → deadline-guarded answer ----
  const conf = await runConfirmation({
    store,
    cfg,
    sessionID,
    signal: context?.signal,
    kind: APPROVE_TOOL_NAME,
    title: `Approve rule ${rule ? `${rule.id} v${rule.version + 1}` : `(new, from ${issue.id})`}?`,
    display: fullDisplay,
    objectHash,
    snapshot,
    snapshotHash,
    deadlineTs,
    deadlineMin,
  })
  const auditBase = { sessionID, ruleId: auditRuleId, issueId: issue?.id ?? null, formID: conf.ok ? conf.formID : null, objectHash, snapshotHash, deadlineTs }
  if (!conf.ok) {
    const outcome =
      conf.error.code === "MEMORY_CONFIRMATION_CANCELLED" || conf.error.code === "MEMORY_CONFIRMATION_INVALID"
        ? "cancelled"
        : conf.error.code === "MEMORY_CONFIRMATION_EXPIRED"
          ? "expired"
          : conf.error.code === "MEMORY_CONFIRMATION_STALE"
            ? "stale"
            : "error"
    return { ...conf.error, ...auditOutcome(store, auditBase, outcome) }
  }

  // ---- critical section: re-check snapshot + record (shared with the CLI) ----
  let submitted
  try {
    submitted = submitDecision({
      store,
      kind: "approve",
      ruleId: auditRuleId,
      issueId: issue?.id ?? null,
      object,
      snapshot,
    })
  } catch (e) {
    const env = submitErrorEnvelope(e)
    const outcome = env.code === "MEMORY_CONFIRMATION_STALE" ? "stale" : env.code === "MEMORY_APPROVAL_BUSY" ? "busy" : "error"
    return { ...env, ...auditOutcome(store, auditBase, outcome, { decisionId: e.decisionId ?? null }) }
  }
  const { decision, rule: newRule } = submitted

  // Post-submit follow-ups must never duplicate the decision — failures carry
  // the decisionId instead (adjudication).
  const receipt = {
    ok: true,
    decisionId: decision.id,
    ruleId: newRule.id,
    version: newRule.version,
    objectHash: decision.objectHash,
    channel,
    targets: channel === "patch-human-apply" ? targets : [],
    formID: conf.formID,
    sessionID,
    snapshotHash,
  }
  if (issue) {
    try {
      ;(cfg.testHooks?.upsertIssue ?? store.upsertIssue.bind(store))({ id: issue.id, status: "approved" })
    } catch (e) {
      receipt.warning = `approval ${decision.id} is recorded, but the candidate status update failed: ${e?.message ?? e} — fix via the CLI digest; do NOT re-run approve (it would record a second version)`
    }
  }
  if (channel === "system-ride") {
    receipt.note =
      "approval recorded — delivery NOT enabled and no file written. To let this rule version ride the system prompt of matching sessions (persistent across sessions), the user must separately confirm memory_enable_delivery."
  } else {
    receipt.note =
      "approval recorded — no patch generated, no file written. Use memory_prepare_publish to produce the patches for MANUAL application (approval ≠ applied)."
  }
  return { ...receipt, ...auditOutcome(store, auditBase, "recorded", { decisionId: decision.id }) }
}

// ═══════════════════════ memory_enable_delivery ═══════════════════════

export const ENABLE_DELIVERY_TOOL_NAME = "memory_enable_delivery"

export const ENABLE_DELIVERY_TOOL_DESCRIPTION =
  "Record the user's authorization to persistently deliver (system-ride) one approved rule version into the system prompt of matching sessions ACROSS SESSIONS, after the user confirms on a hosted single-choice form; blocks until answered. " +
  "Separate from approval — an approved rule never rides until this authorization; it binds the CURRENT version and never reuses a prior authorization."

const ENABLE_DELIVERY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ruleId: {
      type: "string",
      description: "Required. An active rule approved on the system-ride channel and not already delivery-enabled.",
    },
    confirmTimeoutMin: {
      type: "number",
      description: "Optional minutes to wait for the form answer (1–30, default 10).",
    },
  },
  required: ["ruleId"],
  additionalProperties: false,
}

export function buildEnableDeliveryTool({ cfg }) {
  return {
    name: ENABLE_DELIVERY_TOOL_NAME,
    description: ENABLE_DELIVERY_TOOL_DESCRIPTION,
    input: ENABLE_DELIVERY_INPUT_SCHEMA,
    options: { codemode: false },
    execute: async (args, context) => {
      const res = await executeEnableDelivery(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

/** Never throws; every failure path returns the structured envelope (R33). */
export async function executeEnableDelivery(rawArgs, context, { cfg }) {
  try {
    return await runEnableDelivery(rawArgs, context, { cfg })
  } catch (err) {
    return memoryError("INTERNAL", `memory_enable_delivery internal error: ${err?.message ?? err} — report it; do not retry unchanged`)
  }
}

async function runEnableDelivery(rawArgs, context, { cfg }) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {}
  const forged = rejectForgedConfirmation(args)
  if (forged) return forged

  const gate = gateSession(context, cfg)
  if (!gate.ok) return sessionRejected(gate.error)
  const { sessionID } = gate

  const ruleId = typeof args.ruleId === "string" && args.ruleId.length > 0 ? args.ruleId : null
  if (!ruleId) return memoryError("INVALID_INPUT", "ruleId must be the ID of an active system-ride rule")
  const deadlineMin = clampConfirmTimeoutMin(args.confirmTimeoutMin ?? cfg.confirmTimeoutMin)

  const opened = openStoreGated(cfg)
  if (!opened.ok) return opened.error
  const store = opened.store

  let rule
  try {
    rule = store.getRule(ruleId)
  } catch (err) {
    return mapStoreError(err)
  }
  if (!rule) return memoryError("RULE_NOT_FOUND", `rule ${ruleId} does not exist in the store — check the ID via the supervisor-memory CLI status`)
  if (rule.status === "disabled") {
    return memoryError(
      "RULE_DISABLED",
      `rule ${ruleId} is disabled: delivery-enable cannot proceed. Re-enabling means the rule must first be re-enabled and approved as a NEW version (a fresh full approval of a new body — never a delivery switch, never a reuse of the old authorization); run that approval flow first, then retry delivery-enable against the new version`,
    )
  }
  if (rule.status !== "active") {
    return memoryError("RULE_NOT_ACTIVE", `rule ${ruleId} currently has status ${rule.status}; only active (approved) rules can be delivery-enabled`)
  }
  if (rule.channel !== RIDE_CHANNEL) {
    return memoryError("CHANNEL_MISMATCH", `rule ${ruleId} was approved on channel ${rule.channel ?? "unset"} — system-ride delivery applies only to rules approved on the system-ride channel (one rule one channel)`)
  }
  const state = deriveDeliveryState(rule, store.listDecisions())
  if (state.enabled) {
    return {
      ok: true,
      alreadyEnabled: true,
      decisionId: state.decision?.id ?? null,
      ruleId,
      version: rule.version,
      note: `rule ${ruleId} v${rule.version} is already delivery-enabled (${state.decision?.id ?? "decision on record"}) — nothing recorded, nothing changed`,
    }
  }

  const bodyHash = rideBodyHash(rule.body)
  const object = { channel: RIDE_CHANNEL, version: rule.version, bodyHash }
  const objectHash = sha256Hex(canonicalJson(object))

  const display = buildApprovalDisplay({
    headline: `supervisor-memory delivery-enable — ${rule.id} v${rule.version} (channel system-ride)`,
    body: rule.body,
    scopeDescription:
      rule.scope?.kind === "project"
        ? `project ${rule.scope.projectId} (matching root sessions of that project)`
        : rule.scope?.kind === "user-global"
          ? "user-global (all projects)"
          : String(rule.scope?.kind ?? "unset"),
    channel: "system-ride",
    agents: Array.isArray(rule.agents) ? rule.agents : null,
    targets: [],
    reviewDate: typeof rule.reviewDate === "string" ? rule.reviewDate : "n/a",
    objectHash,
    deadlineTs: 0,
    extraLines: [
      `binding (the authorization is bound to exactly this quadruple): ruleId=${rule.id} version=${rule.version} channel=${RIDE_CHANNEL} bodyHash=${bodyHash}`,
      "re-approving the rule to a new version automatically resets delivery to disabled — this authorization covers ONLY this version.",
    ],
  })

  const snapshot = snapshotState(store, { ruleId })
  const snapshotHash = sha256Hex(canonicalJson(snapshot))
  const deadlineTs = Date.now() + deadlineMin * 60_000
  const fullDisplay = `${display}\ndeadline: unanswered requests expire at ${new Date(deadlineTs).toISOString()} and record nothing.`

  const conf = await runConfirmation({
    store,
    cfg,
    sessionID,
    signal: context?.signal,
    kind: ENABLE_DELIVERY_TOOL_NAME,
    title: `Enable persistent system-ride delivery for ${rule.id} v${rule.version}?`,
    display: fullDisplay,
    objectHash,
    snapshot,
    snapshotHash,
    deadlineTs,
    deadlineMin,
  })
  const auditBase = { sessionID, ruleId, issueId: null, formID: conf.ok ? conf.formID : null, objectHash, snapshotHash, deadlineTs }
  if (!conf.ok) {
    const outcome =
      conf.error.code === "MEMORY_CONFIRMATION_CANCELLED" || conf.error.code === "MEMORY_CONFIRMATION_INVALID"
        ? "cancelled"
        : conf.error.code === "MEMORY_CONFIRMATION_EXPIRED"
          ? "expired"
          : conf.error.code === "MEMORY_CONFIRMATION_STALE"
            ? "stale"
            : "error"
    return { ...conf.error, ...auditOutcome(store, auditBase, outcome) }
  }

  let submitted
  try {
    submitted = submitDecision({
      store,
      kind: "delivery-enable",
      ruleId,
      object,
      snapshot,
      // expectRule is redundant with the snapshot compare (version/status are
      // in the snapshot) but keeps the quadruple precondition explicit.
      expectRule: (r) =>
        !r
          ? `rule ${ruleId} vanished`
          : r.status !== "active"
            ? `rule ${ruleId} is ${r.status}; only active rules can be delivery-enabled`
            : null,
    })
  } catch (e) {
    const env = submitErrorEnvelope(e)
    const outcome = env.code === "MEMORY_CONFIRMATION_STALE" ? "stale" : env.code === "MEMORY_APPROVAL_BUSY" ? "busy" : "error"
    return { ...env, ...auditOutcome(store, auditBase, outcome) }
  }

  return {
    ok: true,
    decisionId: submitted.decision.id,
    ruleId,
    version: rule.version,
    bodyHash,
    channel: RIDE_CHANNEL,
    formID: conf.formID,
    sessionID,
    snapshotHash,
    note: `delivery-enabled: rule ${rule.id} v${rule.version} will ride the system prompt of every matching session (persistent across sessions) until delivery is disabled or the rule is re-approved to a new version. Withdrawal only stops appending — text already in history answers or compressed summaries is not retroactively removed.`,
    ...auditOutcome(store, auditBase, "recorded", { decisionId: submitted.decision.id }),
  }
}

// ═══════════════════════ memory_disable_delivery ═══════════════════════

export const DISABLE_DELIVERY_TOOL_NAME = "memory_disable_delivery"

export const DISABLE_DELIVERY_TOOL_DESCRIPTION =
  "Stop delivering (system-ride) a rule into the system prompt of matching sessions by recording the stop decision immediately. " +
  "Call only when the user explicitly asks to stop the delivery; no second confirmation form is shown. Only stops appending — text already in history answers or compressed summaries is not retroactively removed."

const DISABLE_DELIVERY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ruleId: {
      type: "string",
      description: "Required. The rule whose system-ride delivery stops.",
    },
  },
  required: ["ruleId"],
  additionalProperties: false,
}

export function buildDisableDeliveryTool({ cfg }) {
  return {
    name: DISABLE_DELIVERY_TOOL_NAME,
    description: DISABLE_DELIVERY_TOOL_DESCRIPTION,
    input: DISABLE_DELIVERY_INPUT_SCHEMA,
    options: { codemode: false },
    execute: async (args, context) => {
      const res = await executeDisableDelivery(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

/** Never throws; every failure path returns the structured envelope (R33). */
export async function executeDisableDelivery(rawArgs, context, { cfg }) {
  try {
    return await runDisableDelivery(rawArgs, context, { cfg })
  } catch (err) {
    return memoryError("INTERNAL", `memory_disable_delivery internal error: ${err?.message ?? err} — report it; do not retry unchanged`)
  }
}

// Shared body of the two stop-class tools: identity/scope gate kept (root
// session), NO confirmation form (explicit admin request), submit through the
// shared critical section so a concurrent approval cannot interleave (bug ①
// applies to stops too: exactly one of {approve, stop} lands first; the other
// sees a changed snapshot and refuses).
async function runStopClass({ toolName, rawArgs, context, cfg, kind }) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {}
  const forged = rejectForgedConfirmation(args)
  if (forged) return forged

  const gate = gateSession(context, cfg)
  if (!gate.ok) return sessionRejected(gate.error)
  const { sessionID } = gate

  const ruleId = typeof args.ruleId === "string" && args.ruleId.length > 0 ? args.ruleId : null
  if (!ruleId) return memoryError("INVALID_INPUT", "ruleId must be the ID of an existing rule")

  const opened = openStoreGated(cfg)
  if (!opened.ok) return opened.error
  const store = opened.store

  let rule
  try {
    rule = store.getRule(ruleId)
  } catch (err) {
    return mapStoreError(err)
  }
  if (!rule) return memoryError("RULE_NOT_FOUND", `rule ${ruleId} does not exist in the store — check the ID via the supervisor-memory CLI status`)
  if (kind === "disable" && rule.status !== "active") {
    return memoryError("RULE_NOT_ACTIVE", `rule ${ruleId} currently has status ${rule.status}; only active rules can be disabled`)
  }

  // Snapshot taken immediately before the critical section: the section
  // re-checks it, so a concurrent approval/stop that lands first makes this
  // call refuse (fail-closed) instead of acting on a stale view.
  const snapshot = snapshotState(store, { ruleId })
  const snapshotHash = sha256Hex(canonicalJson(snapshot))

  let submitted
  try {
    submitted = submitDecision({ store, kind, ruleId, snapshot })
  } catch (e) {
    const env = submitErrorEnvelope(e)
    const outcome = env.code === "MEMORY_CONFIRMATION_STALE" ? "stale" : env.code === "MEMORY_APPROVAL_BUSY" ? "busy" : "error"
    return { ...env, ...auditOutcome(store, { sessionID, ruleId, issueId: null, formID: null, objectHash: null, snapshotHash }, outcome) }
  }

  const base = {
    ok: true,
    decisionId: submitted.decision.id,
    ruleId,
    sessionID,
    snapshotHash,
  }
  if (kind === "delivery-disable") {
    return {
      ...base,
      note: `delivery-disabled: rule ${ruleId} stops riding on the next model request evaluation. This only stops appending — rule text already present in history answers or compressed summaries is not retroactively removed.`,
      ...auditOutcome(store, { sessionID, ruleId, issueId: null, formID: null, objectHash: null, snapshotHash }, "recorded", { decisionId: submitted.decision.id }),
    }
  }
  return {
    ...base,
    note: `disabled ${ruleId}: store status is now disabled (a human decision; targets preserved). disabled-in-store ≠ residue withdrawn from files — manually applied text stays in target files and in history; nothing is retroactively removed.`,
    ...auditOutcome(store, { sessionID, ruleId, issueId: null, formID: null, objectHash: null, snapshotHash }, "recorded", { decisionId: submitted.decision.id }),
  }
}

async function runDisableDelivery(rawArgs, context, { cfg }) {
  return runStopClass({ toolName: DISABLE_DELIVERY_TOOL_NAME, rawArgs, context, cfg, kind: "delivery-disable" })
}

// ═══════════════════════ memory_disable_rule ═══════════════════════

export const DISABLE_RULE_TOOL_NAME = "memory_disable_rule"

export const DISABLE_RULE_TOOL_DESCRIPTION =
  "Disable an approved rule in the memory store (status disabled; targets preserved). " +
  "Call only when the user explicitly asks to disable the rule; no second confirmation form is shown. Disabled-in-store does not withdraw text already applied to files or already present in history."

const DISABLE_RULE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ruleId: {
      type: "string",
      description: "Required. The active rule to disable.",
    },
  },
  required: ["ruleId"],
  additionalProperties: false,
}

export function buildDisableRuleTool({ cfg }) {
  return {
    name: DISABLE_RULE_TOOL_NAME,
    description: DISABLE_RULE_TOOL_DESCRIPTION,
    input: DISABLE_RULE_INPUT_SCHEMA,
    options: { codemode: false },
    execute: async (args, context) => {
      const res = await executeDisableRule(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

/** Never throws; every failure path returns the structured envelope (R33). */
export async function executeDisableRule(rawArgs, context, { cfg }) {
  try {
    return await runDisableRule(rawArgs, context, { cfg })
  } catch (err) {
    return memoryError("INTERNAL", `memory_disable_rule internal error: ${err?.message ?? err} — report it; do not retry unchanged`)
  }
}

async function runDisableRule(rawArgs, context, { cfg }) {
  return runStopClass({ toolName: DISABLE_RULE_TOOL_NAME, rawArgs, context, cfg, kind: "disable" })
}

// ═══════════════════════ registration ═══════════════════════

/** All four phase-3 tools in registration order (added inside buildMemoryTools). */
export function buildApprovalTools({ cfg }) {
  return [
    buildApproveRuleTool({ cfg }),
    buildEnableDeliveryTool({ cfg }),
    buildDisableDeliveryTool({ cfg }),
    buildDisableRuleTool({ cfg }),
  ]
}
