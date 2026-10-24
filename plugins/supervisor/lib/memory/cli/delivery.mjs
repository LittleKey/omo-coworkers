// v6.2 system-ride delivery authorization commands (§III.8).
//
// delivery-enable / delivery-disable: human CLI decisions binding
// (ruleId, version, bodyHash, channel). The enable object is verified against
// the CURRENT rule state inside the store transaction (fail-closed); a
// re-approved (new-version) rule auto-invalidates the old delivery-enable.
//
// Withdrawal wording (R32-G): disable only promises to STOP APPENDING — old
// rule text already present in history answers and compressed summaries does
// not disappear retroactively.
//
// D5: both commands append authorization records, so they pass through the
// same requireHealthy() gate as approve/disable.

import fs from "node:fs"

import { canonicalJson, sha256Hex } from "../store.mjs"
import { deriveDeliveryState, rideBodyHash, RIDE_CHANNEL } from "../ride.mjs"
import { describeSubmitError, snapshotState, submitDecision } from "../approval-service.mjs"
import { humanStoreError } from "./cli.mjs" // function decl — cycle-safe (cli.mjs imports this module for dispatch)

function sha16(hex) {
  return String(hex).slice(0, 16) + "…"
}

function objectHashOf(object) {
  return sha256Hex(canonicalJson(object))
}

function loadRuleOrRefuse(ctx, ruleId) {
  const { store, io } = ctx
  if (typeof ruleId !== "string" || ruleId.length === 0) {
    io.print("usage: supervisor-memory delivery-enable <ruleId> | delivery-disable <ruleId>")
    return null
  }
  const rule = store.getRule(ruleId)
  if (!rule) {
    io.print(`rule ${ruleId} not found (rules start with RUL-; list them via supervisor-memory status).`)
    return null
  }
  return rule
}

/**
 * delivery-enable <RUL-…>: 3-stage TTY authorization of system-ride delivery
 * for one rule version. Refuses duplicates (an already-enabled current
 * version records nothing) and any channel/version/hash mismatch (the store
 * re-verifies inside the transaction).
 */
export async function runDeliveryEnable(ctx, ruleId) {
  const { store, io } = ctx
  try {
    store.requireHealthy() // D5
    const rule = loadRuleOrRefuse(ctx, ruleId)
    if (!rule) return 1
    if (rule.status !== "active") {
      io.print(`rejected: rule ${ruleId} currently has status ${rule.status}; only active (approved) rules can be delivery-enabled.`)
      return 1
    }
    if (rule.channel !== RIDE_CHANNEL) {
      io.print(`rejected: rule ${ruleId} was approved on channel ${rule.channel ?? "unset"} — system-ride delivery applies only to rules approved on the system-ride channel (one rule one channel).`)
      return 1
    }
    const state = deriveDeliveryState(rule, store.listDecisions())
    if (state.enabled) {
      io.print(`rule ${ruleId} v${rule.version} is already delivery-enabled (${state.decision?.id ?? "decision on record"}) — nothing recorded.`)
      return 0
    }

    const bodyHash = rideBodyHash(rule.body)
    const object = { channel: RIDE_CHANNEL, version: rule.version, bodyHash }
    // Stage-2 snapshot for the approval critical section (bug ① fix): the
    // record is submitted through the shared service layer, which re-checks
    // this snapshot inside the cross-process lock — a concurrent
    // approve/stop/version bump between confirm and record cannot interleave.
    const before = snapshotState(store, { ruleId: rule.id })

    // ---- stage 1: what will happen ----
    io.print("────────────── delivery-enable (stage 1/3) ──────────────")
    io.print(`rule: ${rule.id} v${rule.version} (channel ${rule.channel})`)
    io.print("body:")
    for (const l of String(rule.body).split("\n")) io.print(`  | ${l}`)
    io.print(`effective scope: ${rule.scope?.kind === "project" ? `project ${rule.scope.projectId}` : rule.scope?.kind === "user-global" ? "user-global (all projects)" : String(rule.scope?.kind ?? "unset")}`)
    io.print(`agent restriction: ${Array.isArray(rule.agents) && rule.agents.length > 0 ? rule.agents.join(", ") : "none (all agents)"}`)
    io.print("effect: the rule body will be injected into the system prompt of every model request of matching sessions (persistent within session), until a delivery-disable is recorded or the rule is re-approved to a new version (which auto-resets delivery to disabled).")
    io.print("withdrawal semantics: disable only stops appending — rule text already present in history answers or compressed summaries is not retroactively removed.")
    if (!(await io.confirm("Record delivery-enable for this rule version?"))) {
      io.print("cancelled — no decision recorded.")
      return 1
    }

    // ---- stage 2: binding display ----
    io.print("────────────── binding (stage 2/3) ──────────────")
    io.print(`binding: ruleId=${rule.id} version=${rule.version} channel=${RIDE_CHANNEL}`)
    io.print(`bodyHash: ${bodyHash}`)
    io.print(`binding object hash: ${sha16(objectHashOf(object))}`)

    // ---- stage 3: confirm and record (store re-verifies the quadruple) ----
    if (!(await io.confirm("Confirm recording this binding?"))) {
      io.print("cancelled — no decision recorded.")
      return 1
    }
    let recorded
    try {
      recorded = submitDecision({
        store,
        kind: "delivery-enable",
        ruleId: rule.id,
        object,
        snapshot: before,
        expectRule: (r) =>
          r.status === "active" && r.channel === RIDE_CHANNEL && r.version === rule.version
            ? null
            : `rule ${rule.id} changed under the confirmation (status/version/channel no longer match)`,
      })
    } catch (e) {
      const msg = describeSubmitError(e)
      if (msg) {
        io.print(msg)
        io.print("no decision was recorded this time; re-run delivery-enable from stage 1.")
        return 1
      }
      throw e
    }
    const { decision } = recorded
    io.print(`delivery-enabled: ${decision.id} — rule ${rule.id} v${rule.version} will ride the system prompt of matching sessions (root sessions, project-scoped, agent-matched; budget 1200 chars per request).`)
    return 0
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

/** delivery-disable <RUL-…>: record the stop-appending decision.
 * Stop-class: an explicit CLI invocation IS the admin request, so there is no
 * second confirmation (bug ③ fix) — identity (TTY CLI) and scope validation
 * stay. Routed through the shared approval critical section. */
export async function runDeliveryDisable(ctx, ruleId) {
  const { store, io } = ctx
  try {
    store.requireHealthy() // D5
    const rule = loadRuleOrRefuse(ctx, ruleId)
    if (!rule) return 1

    io.print(`rule: ${rule.id} v${rule.version} (channel ${rule.channel ?? "unset"})`)
    io.print("effect: matching sessions stop receiving this rule in the system prompt. This only stops appending — rule text already present in history answers or compressed summaries does not disappear.")
    const { decision } = submitDecision({
      store,
      kind: "delivery-disable",
      ruleId: rule.id,
    })
    io.print(`delivery-disabled: ${decision.id} — rule ${rule.id} will stop riding on the next model request evaluation.`)
    return 0
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

/**
 * Digest sentinel line (§III.8): one line per delivery-enabled runtime rule —
 * "recent N eligible sessions, M rides + agent-name distribution" over the
 * available plugin-log window (memory_ride_eval entries). N comes from the
 * log window; when the log carries no session data the sentinel prints
 * "unknown" — a silently broken binding (e.g. renamed agent) is exactly what
 * this line must expose.
 */
export function printRideSentinel(store, { logPath } = {}) {
  const rules = store.listRules()
  const decisions = store.listDecisions()
  const enabled = rules.filter((r) => r.channel === RIDE_CHANNEL && deriveDeliveryState(r, decisions).enabled)
  if (enabled.length === 0) return

  const evals = []
  try {
    const raw = fs.readFileSync(logPath, "utf8")
    for (const line of raw.split("\n")) {
      if (!line) continue
      try {
        const e = JSON.parse(line)
        if (e?.kind === "memory_ride_eval") evals.push(e)
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* no log readable */
  }

  console.log("system-ride sentinel (delivery-enabled runtime rules):")
  if (evals.length === 0) {
    console.log("  no session data in the plugin log window (unknown)")
    return
  }
  for (const rule of enabled) {
    const mine = evals.filter((e) => Array.isArray(e.rules) && e.rules.some((r) => r.ruleId === rule.id))
    const eligibleSessionIds = new Set()
    let rides = 0
    for (const e of mine) {
      for (const r of e.rules) {
        if (r.ruleId !== rule.id) continue
        if (r.outcome === "rode" || r.outcome === "would-ride" || r.outcome === "skipped:memory-cap-1200") {
          eligibleSessionIds.add(e.sessionId)
          if (r.outcome === "rode") rides += 1
        }
      }
    }
    const agents = [...new Set(mine.map((e) => e.agent).filter((a) => typeof a === "string" && a.length > 0))]
    console.log(
      `  ${rule.id} v${rule.version} — recent ${eligibleSessionIds.size} eligible sessions, ${rides} rides, agents seen: ${agents.length ? agents.join(", ") : "none"}`,
    )
  }
}
