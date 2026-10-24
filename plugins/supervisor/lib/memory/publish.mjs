// prepare_publish — model tool face, v6.0 design Part III step 1a (§III.1
// row 3; named prepare_publish precisely because it does NOT publish: zero
// file writes). For an APPROVED rule (status active + a matching approve
// decision in the store) it regenerates the apply-patch text with the exact
// same shared composition the CLI approve printer uses (cli/patch.mjs
// formatRulePatch → generatePatch + formatPatch), so tool output is
// byte-identical to what a fresh CLI approval prints for the same object.
//
// Boundaries (III.1): the receipt always states the patch is NOT applied;
// the tool performs NO publish registration — the D9 in-place confirmation
// stays a read-only check of the human CLI digest. D8 target conditions are
// re-verified from current state (file exists, directory confirmed, target
// within the approved scope); any drift → reject with the reason (target
// changed → human review, fail-closed).
//
// No confirmed/approved parameter exists (III.1: confirmation is a host
// event, never a model-supplied argument).
// Description lint (III.0): object semantics / input / effect / failure
// statements only. Amendment trail: initial text 2026-10-23; same day,
// translated to English (R26 three-part format, user request m01908) —
// semantics unchanged, no recorded corrections.
import fs from "node:fs"
import os from "node:os"

import { formatRulePatch, PatchError } from "./cli/patch.mjs"
import { candidateTargets, whyTarget } from "./cli/targets.mjs"
import { describeScope } from "./cli/approve.mjs"
import { gateSession, openStoreFor, storeOpenError } from "./common.mjs"

export const PREPARE_PUBLISH_TOOL_NAME = "prepare_publish"

export const TOOL_DESCRIPTION =
  "Generates the apply-patch text for one approved rule; zero writes to target files. " +
  "Input: ruleId (must be approved, with a matching approval decision record). " +
  "Effect: returns the full patch block and target path; the patch is NOT applied — applying requires a human (or human-authorized agent) to paste/write it; the tool performs no publish registration, and in-place confirmation is the human-review CLI digest read-only check. " +
  "Failure: unknown, unapproved, or disabled rule; no registered targets; or a target failing publish conditions (missing file, unconfirmed directory, outside the approved scope, changed target content) rejects with the reason."

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    ruleId: {
      type: "string",
      description: "Rule ID (RUL-…); must be approved with a matching approval decision record",
    },
  },
  required: ["ruleId"],
  additionalProperties: false,
}

export function buildPreparePublishTool({ cfg }) {
  return {
    name: PREPARE_PUBLISH_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input: INPUT_SCHEMA,
    options: { codemode: false },
    execute: async (args, context) => {
      const res = await executePreparePublish(args, context, { cfg })
      return { ...res, content: JSON.stringify(res) }
    },
  }
}

/** Never throws; every failure path returns {ok:false, error}. */
export async function executePreparePublish(rawArgs, context, { cfg }) {
  try {
    return await runPreparePublish(rawArgs, context, { cfg })
  } catch (err) {
    return { ok: false, error: `prepare_publish internal error: ${err?.message ?? err}` }
  }
}

/**
 * The previous version a replace-patch replaces. Store facts (P1, unchanged
 * semantics): a FIRST approval is recorded with decision.ruleId = null (the
 * rule id is minted inside the transaction); re-approvals carry the rule id.
 * So the current decision is matched via rule.approvalRef.decisionId over ALL
 * approve decisions, and the previous body comes from the approve decision
 * before the current one in this rule's chain — for version 2 that is the
 * minting decision (last ruleId-null approve before current). A wrong guess
 * cannot yield a wrong patch: generatePatch cross-checks the claimed
 * previous body against the target segment and fails closed to human review.
 * version 1 → null (first-time add). No recoverable predecessor → null;
 * generatePatch then fails closed if the target already carries a segment.
 */
function previousVersionOf(rule, reApprovals, mint) {
  if (rule.version <= 1) return null
  const prev = reApprovals[reApprovals.length - 2]
  if (prev) return { version: rule.version - 1, body: prev.object?.body }
  if (rule.version === 2 && mint) return { version: 1, body: mint.object?.body }
  return null
}

async function runPreparePublish(rawArgs, context, { cfg }) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {}

  const gate = gateSession(context, cfg)
  if (!gate.ok) return { ok: false, error: gate.error }

  const ruleId = typeof args.ruleId === "string" ? args.ruleId.trim() : ""
  if (ruleId.length === 0) {
    return { ok: false, error: "ruleId must be a rule ID string (RUL-…)" }
  }

  let store
  try {
    store = openStoreFor(cfg)
  } catch (err) {
    return { ok: false, error: storeOpenError(err) }
  }

  const rule = store.getRule(ruleId) // throws (fail-closed) on damaged stores
  if (!rule) {
    return { ok: false, error: `rejected: rule ${ruleId} does not exist in the store` }
  }
  if (rule.status === "disabled") {
    return { ok: false, error: `rejected: rule ${ruleId} is disabled; re-enabling requires a fresh approval and never goes through this tool` }
  }
  if (rule.status !== "active" || !rule.approvalRef) {
    return { ok: false, error: `rejected: rule ${ruleId} is not in an approved state (current ${rule.status})` }
  }
  // listDecisions({ruleId}) cannot find a v1 rule's approving decision
  // (first approvals carry decision.ruleId = null — store semantics), so the
  // current decision is matched via approvalRef over all approve decisions.
  const approves = store.listDecisions({ kind: "approve" })
  const current = approves.find((d) => d.id === rule.approvalRef?.decisionId)
  if (!current) {
    return { ok: false, error: `rejected: no approval decision record matching the current version of rule ${ruleId}` }
  }
  const reApprovals = approves.filter((d) => d.ruleId === ruleId)
  const mint = approves
    .filter((d) => d.ruleId === null && d.seq < current.seq)
    .at(-1)

  const targets = Array.isArray(rule.targets) ? rule.targets : []
  if (targets.length === 0) {
    return { ok: false, error: `rejected: rule ${ruleId} has no registered targets (never published); targets are fixed during manual approval (approve)` }
  }

  // D8 re-verification from CURRENT state: every registered target must
  // still be an in-scope candidate that exists, with a confirmed directory.
  const candidates = candidateTargets({
    scope: rule.scope,
    projects: store.listProjects(),
    cwd: null, // the tool face never widens scope via an unregistered cwd
    home: os.homedir(),
  })
  const previous = previousVersionOf(rule, reApprovals, mint)
  const patches = []
  for (const t of targets) {
    const c = candidates.find((x) => x.path === t)
    if (!c) {
      return { ok: false, error: `rejected: target ${t} is inconsistent with the rule's approved scope — send for human review, no patch generated` }
    }
    if (!c.exists) {
      return { ok: false, error: `rejected: target file does not exist — new files are never created (${t})` }
    }
    if (c.confirmedDir === false) {
      return { ok: false, error: `rejected: target directory unconfirmed (${c.directory}) — directory confirmation is an explicit human action (projects.json)` }
    }
    let content
    try {
      content = fs.readFileSync(t, "utf8")
    } catch {
      return { ok: false, error: `rejected: target ${t} unreadable — target changed? send for human review (never inferred as user deletion)` }
    }
    try {
      patches.push({
        path: t,
        patch: formatRulePatch({
          targetPath: t,
          why: whyTarget(c),
          scopePromise: describeScope(rule.scope),
          trackedNote: c.note,
          fileContent: content,
          ruleId: rule.id,
          version: rule.version,
          body: rule.body,
          previous,
        }),
      })
    } catch (err) {
      const detail = err instanceof PatchError ? err.message : String(err?.message ?? err)
      return { ok: false, error: `rejected: patch generation failed for target ${t} — ${detail}` }
    }
  }

  return {
    ok: true,
    ruleId: rule.id,
    version: rule.version,
    applied: false,
    patches,
    note: "not applied: requires a human (or a human-authorized agent) to paste/write; presence confirmation is done by the read-only check of the human-review CLI (supervisor-memory digest)",
  }
}
