// v6.2 system-ride delivery channel (design §III.8, R31+R32).
//
// Position: project×agent bounded delivery of approved rules. Delivery-only —
// detection stays closed (§III.7). Form: the matched rule body is appended
// idempotently to the tail of the context hook's event.system array on every
// model request (probe /tmp/opencode/probe-system/: system is
// Array<{type:"text",text:string}>, mutable, effective upstream, REBUILT by
// the host per request — so every hook invocation must re-append; nothing
// accumulates). Session-persistent, compression-proof, restart-reinjects,
// zero delivery state machine.
//
// Gate (all deterministic, fail-closed):
//   1. rule approved (active) + latest delivery-enable decision + channel ==
//      system-ride (channel enum static-agents-md | system-ride; one rule one
//      channel);
//   2. root sessions only (parent_id non-null → refused; subagent children
//      fire the same hook — without explicit per-child authorization v1 never
//      delivers to them);
//   3. project match: session.project_id == rule.scope.projectId (user-global
//      rules are unrestricted; directory scope cannot be matched → refused);
//   4. agent match: the host-provided current-request agent name equals
//      rule.agents[0] literally; empty agents = unrestricted; unknown/missing
//      agent name → refuse. A renamed agent silently stops delivery (no
//      auto-rebind) — exposed by the digest sentinel line.
//
// Budget: ≤1200 chars per request INCLUDING headers; rules load whole, in
// fixed order (approval time); a whole item that does not fit is skipped and
// logged (skipped:memory-cap-1200) — never truncated, never rotated
// (persistent overflow = a human should trim the rule).
//
// Withdrawal wording (R32-G): disable/close/channel-switch only promise to
// STOP APPENDING; old rule text already in history/compressed summaries does
// not disappear.

import { createHash } from "node:crypto"

import { checkCurrentSession, openStoreFor, storeOpenError } from "./common.mjs"
import { defaultHostDbPath } from "./evidence.mjs"

export const RIDE_BUDGET_CHARS = 1200
export const RIDE_CHANNEL = "system-ride"

/** Binding hash of a rule body (delivery-enable quadruple component). */
export function rideBodyHash(body) {
  return createHash("sha256").update(String(body), "utf8").digest("hex")
}

/** Injection header for one rule version. */
export function rideMarker(rule) {
  return `[supervisor-memory:rule:${rule.id}:v${rule.version}]`
}

/** Full injected element text (header + body). */
export function rideElementText(rule) {
  return `${rideMarker(rule)}\n${rule.body}`
}

/**
 * Derive the delivery state of one rule from the decision log (append-order
 * = store.listDecisions() order, newest last). Enabled only when the LATEST
 * delivery decision for the rule is a delivery-enable whose binding matches
 * the rule's CURRENT version, body hash and channel — a re-approve to a new
 * version therefore auto-resets delivery to disabled.
 *
 * @param rule current rule record (store.getRule / listRules entry)
 * @param decisions all decisions (store.listDecisions())
 * @returns {{enabled: boolean, reason: string, decision: object|null}}
 */
export function deriveDeliveryState(rule, decisions) {
  const rel = (Array.isArray(decisions) ? decisions : []).filter(
    (d) => d && (d.kind === "delivery-enable" || d.kind === "delivery-disable") && d.ruleId === rule.id,
  )
  const latest = rel.length ? rel[rel.length - 1] : null
  if (!latest) return { enabled: false, reason: "no delivery decision recorded", decision: null }
  if (latest.kind !== "delivery-enable") {
    return { enabled: false, reason: "latest delivery decision is delivery-disable", decision: latest }
  }
  const o = latest.object ?? {}
  if (o.channel !== RIDE_CHANNEL || rule.channel !== RIDE_CHANNEL) {
    return { enabled: false, reason: "channel mismatch between binding and rule", decision: latest }
  }
  if (o.version !== rule.version) {
    return {
      enabled: false,
      reason: `rule re-approved to v${rule.version} — the delivery-enable for v${o.version} auto-reset (disabled)`,
      decision: latest,
    }
  }
  if (o.bodyHash !== rideBodyHash(rule.body)) {
    return { enabled: false, reason: "body hash mismatch against the binding", decision: latest }
  }
  return { enabled: true, reason: "delivery-enabled (quadruple verified)", decision: latest }
}

/**
 * Pure matcher: which rules ride for this request. Deterministic, no I/O.
 *
 * @returns {{picked: object[], skipped: object[], rejected: object[]}}
 *   picked  — rules to inject, fixed order (approval time then id), whole
 *             items within the per-request budget;
 *   skipped — whole items that did not fit (never truncated);
 *   rejected — gate failures with the failing reason.
 */
export function matchRideRules({ rules, decisions, projectId, agent, budget = RIDE_BUDGET_CHARS }) {
  const candidates = []
  const rejected = []
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || typeof rule.id !== "string") continue
    if (rule.status !== "active") {
      rejected.push({ ruleId: rule.id, stage: "status", reason: `rule is ${rule.status}, not approved-active` })
      continue
    }
    if (rule.channel !== RIDE_CHANNEL) {
      rejected.push({ ruleId: rule.id, stage: "channel", reason: `channel is ${rule.channel ?? "unset"}, not system-ride` })
      continue
    }
    const st = deriveDeliveryState(rule, decisions)
    if (!st.enabled) {
      rejected.push({ ruleId: rule.id, stage: "delivery", reason: st.reason })
      continue
    }
    const scope = rule.scope ?? {}
    if (scope.kind === "project") {
      if (!projectId || scope.projectId !== projectId) {
        rejected.push({ ruleId: rule.id, stage: "project", reason: "session project does not match the rule scope" })
        continue
      }
    } else if (scope.kind !== "user-global") {
      rejected.push({ ruleId: rule.id, stage: "scope", reason: `scope kind ${scope.kind ?? "unset"} cannot be matched by system-ride` })
      continue
    }
    const agents = Array.isArray(rule.agents) ? rule.agents : []
    if (agents.length > 0) {
      if (typeof agent !== "string" || agent.length === 0 || agents[0] !== agent) {
        rejected.push({ ruleId: rule.id, stage: "agent", reason: "current-request agent unknown or not the bound agent (literal match)" })
        continue
      }
    }
    candidates.push(rule)
  }
  // Fixed order: rule approval time, id as tiebreaker.
  candidates.sort((a, b) => (a.createdAtTs ?? 0) - (b.createdAtTs ?? 0) || String(a.id).localeCompare(String(b.id)))
  const picked = []
  const skipped = []
  let used = 0
  for (const rule of candidates) {
    const item = rideElementText(rule)
    if (used + item.length > budget) {
      skipped.push({
        ruleId: rule.id,
        version: rule.version,
        outcome: "skipped:memory-cap-1200",
        reason: `whole item is ${item.length} chars, ${budget - used} left of ${budget} — never truncated, never rotated`,
      })
      continue
    }
    used += item.length
    picked.push(rule)
  }
  return { picked, skipped, rejected }
}

/**
 * Ride injector bound to the plugin lifetime. Created once in setup; its
 * onContext(event) runs at the SAME mount point as the v2 context handler
 * (after the L0 handler so the L0/inject path is never affected). Every
 * failure is logged and swallowed — memory delivery can never take the
 * plugin down (D1 fault isolation).
 *
 * Modes (options.memory.delivery): "off" (default) = no-op; "shadow" = the
 * full gate runs and wouldRide is logged (match basis + per-item skip
 * reasons) but event.system is never touched; "inject" = actual push.
 *
 * Shape defense: if event.system is not Array<{type:"text",text:string}>,
 * ONLY memory injection is disabled (latched for the plugin lifetime — the
 * host must be re-probed after an upgrade); the rest of the plugin is
 * unaffected.
 *
 * @param {{cfg: object, log?: Function, dbPath?: string}} args
 */
export function createRideInjector({ cfg, log, dbPath } = {}) {
  const delivery = cfg?.delivery === "shadow" ? "shadow" : cfg?.delivery === "inject" ? "inject" : "off"
  const hostDbPath = dbPath ?? cfg?.dbPath ?? defaultHostDbPath()
  let shapeGuardLatched = false
  const loggedOnce = new Set()

  const note = (entry) => {
    if (!log) return
    try {
      log(entry)
    } catch {
      /* never propagate */
    }
  }
  const noteOnce = (entry) => {
    const key = `${entry.kind}:${entry.reason ?? ""}`
    if (loggedOnce.has(key)) return
    loggedOnce.add(key)
    note(entry)
  }

  return {
    /** Test/inspection surface. */
    get state() {
      return { delivery, shapeGuardLatched, hostDbPath }
    },

    /**
     * One context-hook invocation. Reads fresh rule/decision state per call
     * (the send-time re-verification required by §III.8: the quadruple is
     * re-derived from the decision log immediately before injection).
     */
    async onContext(event) {
      if (delivery === "off") return
      if (shapeGuardLatched) return
      try {
        const system = event?.system
        if (
          !Array.isArray(system) ||
          system.some((el) => !el || typeof el !== "object" || el.type !== "text" || typeof el.text !== "string")
        ) {
          shapeGuardLatched = true
          note({
            kind: "memory_shape_guard",
            sessionId: typeof event?.sessionID === "string" ? event.sessionID : null,
            detail:
              "event.system is not Array<{type:'text',text:string}> — memory injection disabled only (latched; re-probe after host upgrade); the rest of the plugin is unaffected",
          })
          return
        }

        const sessionID = typeof event?.sessionID === "string" && event.sessionID.length > 0 ? event.sessionID : null
        if (!sessionID) {
          noteOnce({ kind: "memory_ride_skip", reason: "missing session identity — refusing (fail-closed)" })
          return
        }
        // Root/child + project identity from the host DB (fail-closed).
        const sess = checkCurrentSession({ dbPath: hostDbPath, sessionID })
        if (!sess.ok) {
          noteOnce({ kind: "memory_ride_skip", sessionId: sessionID, reason: `session gate: ${sess.reason}` })
          return
        }
        // Agent identity comes from the host context event (probe: event key
        // "agent"); unknown/missing → refuse to deliver.
        const agent = typeof event?.agent === "string" && event.agent.length > 0 ? event.agent : null
        if (agent === null) {
          noteOnce({ kind: "memory_ride_skip", sessionId: sessionID, reason: "unknown/missing agent name — refusing (fail-closed)" })
          return
        }

        let rules
        let decisions
        try {
          const store = openStoreFor(cfg)
          rules = store.listRules()
          decisions = store.listDecisions()
        } catch (err) {
          noteOnce({ kind: "memory_ride_skip", sessionId: sessionID, reason: `store: ${storeOpenError(err)}` })
          return
        }

        const { picked, skipped, rejected } = matchRideRules({ rules, decisions, projectId: sess.projectId, agent })

        const evalRules = []
        for (const rule of picked) {
          const text = rideElementText(rule)
          // Request-inner dedup guard: the host rebuilds system per request,
          // which is NOT the same as push being idempotent — a repeated hook
          // call on the same array must not append twice.
          if (system.some((el) => typeof el?.text === "string" && el.text.includes(rideMarker(rule)))) {
            evalRules.push({ ruleId: rule.id, version: rule.version, outcome: delivery === "inject" ? "rode" : "would-ride", dedup: true })
            continue
          }
          if (delivery === "inject") {
            // Append-only: never rewrite existing elements.
            system.push({ type: "text", text })
          }
          evalRules.push({ ruleId: rule.id, version: rule.version, outcome: delivery === "inject" ? "rode" : "would-ride" })
        }
        for (const s of skipped) evalRules.push({ ruleId: s.ruleId, version: s.version, outcome: s.outcome })
        for (const r of rejected) evalRules.push({ ruleId: r.ruleId, outcome: "rejected", stage: r.stage })

        note({
          kind: "memory_ride_eval",
          sessionId: sessionID,
          agent,
          delivery,
          projectId: sess.projectId,
          rules: evalRules,
          basis: {
            picked: picked.map((r) => `${r.id}@v${r.version}`),
            skipped: skipped.map((s) => `${s.ruleId}: ${s.reason}`),
            rejected: rejected.map((r) => `${r.ruleId}: ${r.reason}`),
          },
        })
      } catch (err) {
        note({ kind: "internal_error", where: "memory.ride", error: String(err?.message ?? err) })
      }
    },
  }
}
