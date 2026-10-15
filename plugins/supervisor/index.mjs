// supervisor-nudge — opencode plugin, L0 bounded implementation.
//
// Spec: docs/supervisor-nudge-design-v2.md (authoritative). Phase mapping:
//   mode "observe" (default) = phase one: log-only, zero injection/wake/LLM.
//   mode "inject"            = phase two: minimal L0 pre-request injection.
//
// Registers exactly two hooks:
//   event                                  — single observation source
//   experimental.chat.messages.transform   — single injection point
//
// The default export is the plugin factory and returns the hooks object
// DIRECTLY (wrapping it in { hooks: {} } is silently ignored by the host).
// Node builtins only; no timers, no LLM calls, never throws into the host.

import { resolveConfig } from "./lib/config.mjs"
import { createObserveLog } from "./lib/log.mjs"
import {
  createLedger,
  observeRing,
  countDiscard,
  blacklist,
  newRealUserTurn,
  appendUserText,
  getUserTurnText,
  recordAssistantDecision,
  recordAdviserCall,
  recordTodowrite,
  recordTaskCompleted,
  evidenceHash,
  isAdviserSubagent,
  RingIdSet,
} from "./lib/ledger.mjs"
import {
  SUBAGENT_EVENT_PREFIX,
  isAdvisorSessionName,
  findSyntheticMarker,
  findInternalMetadataKey,
  findTaskCompletedSignal,
} from "./lib/filter.mjs"
import { evaluateAllRules } from "./lib/rules.mjs"
import {
  offerCandidate,
  expireAll,
  expireCandidate,
  isBindingValid,
  markInjected,
} from "./lib/candidates.mjs"
import { formatNudge, buildInjectedMessage } from "./lib/nudge.mjs"

export const SupervisorNudge = async (_pluginInput, options) => {
  const cfg = resolveConfig(options)
  const log = createObserveLog(cfg)
  const led = createLedger(cfg)

  log.write({
    kind: "plugin_init",
    mode: cfg.mode,
    logPath: cfg.logPath,
    injectPerSessionMax: cfg.injectPerSessionMax,
    nudgeMaxChars: cfg.nudgeMaxChars,
    sessionLruMax: cfg.sessionLruMax,
    ringBufferMax: cfg.ringBufferMax,
  })

  function discard(rec, reason, extra) {
    countDiscard(rec, reason)
    log.write({ kind: "l0_discard", sessionId: rec.id, reason, ...extra })
  }

  // ---------------- event hook (single observation source) ----------------

  function routeEvent(event) {
    const type = event?.type
    if (typeof type !== "string") return
    const props = event.properties ?? {}

    // OMO subagent announcements: blacklist the child session outright.
    if (type.startsWith(SUBAGENT_EVENT_PREFIX)) {
      const sid = props.sessionID ?? props.info?.id
      if (typeof sid === "string") {
        const rec = led.ensure(sid)
        if (blacklist(rec, "subagent_session")) {
          log.write({ kind: "l0_discard", sessionId: sid, reason: "blacklist_subagent_session" })
        }
      }
      return
    }

    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = props.info
        if (!info?.id) return
        const rec = led.ensure(info.id)
        observeRing(rec, type, cfg.ringBufferMax)
        if (info.parentID) {
          if (blacklist(rec, "child_session")) {
            log.write({ kind: "l0_discard", sessionId: rec.id, reason: "blacklist_child_session" })
          }
        } else if (isAdvisorSessionName(info.title)) {
          if (blacklist(rec, "advisor_named_session")) {
            log.write({ kind: "l0_discard", sessionId: rec.id, reason: "blacklist_advisor_named_session" })
          }
        }
        return
      }
      case "session.deleted":
        led.drop(props.info?.id ?? props.sessionID)
        return
      case "session.compacted": {
        const rec = led.recall(props.sessionID)
        if (!rec) return
        rec.unstable = "compacted"
        expireAll(rec, "compacted")
        log.write({ kind: "unstable", sessionId: rec.id, cause: "compacted" })
        return
      }
      case "message.updated": {
        const info = props.info
        if (!info?.sessionID) return
        const rec = led.recall(info.sessionID)
        if (!rec) return
        observeRing(rec, type, cfg.ringBufferMax)
        if (rec.blacklisted) return
        if (info.role === "user") {
          if (rec.knownUserIds.has(info.id)) return
          const metaKey = findInternalMetadataKey(info)
          if (metaKey) {
            rec.ignoredMessageIds.add(info.id)
            discard(rec, "metadata_internal", { messageId: info.id, metaKey })
            return
          }
          if (newRealUserTurn(rec, info.id)) {
            log.write({ kind: "user_turn", sessionId: rec.id, turn: rec.turnCount, messageId: info.id })
          }
          return
        }
        if (info.role === "assistant") {
          if (info.summary) return // title/summary artifacts are not decisions
          recordAssistantDecision(rec, info.id)
        }
        return
      }
      case "message.part.updated": {
        const part = props.part
        if (!part?.sessionID) return
        const rec = led.recall(part.sessionID)
        if (!rec || rec.blacklisted) return
        observeRing(rec, type, cfg.ringBufferMax)
        return handlePart(rec, part)
      }
      case "todo.updated": {
        const rec = led.recall(props.sessionID)
        if (!rec || rec.blacklisted) return
        if (Array.isArray(props.todos)) recordTodowrite(rec, props.todos)
        return
      }
      case "message.removed":
      case "message.part.removed": {
        const rec = led.recall(props.sessionID)
        if (!rec) return
        rec.unstable = "revert"
        expireAll(rec, "revert")
        log.write({ kind: "unstable", sessionId: rec.id, cause: "revert" })
        return
      }
      case "session.idle":
      case "session.status": {
        const rec = led.recall(props.sessionID)
        if (rec) observeRing(rec, type, cfg.ringBufferMax)
        return
      }
      default:
        return
    }
  }

  function handlePart(rec, part) {
    if (part.type === "text") {
      // Rule B evidence is scanned BEFORE synthetic filtering so terminal
      // markers delivered inside machine text still register.
      const signal = findTaskCompletedSignal(part.text)
      if (signal) recordTaskCompleted(rec, signal)
      if (rec.ignoredMessageIds.has(part.messageID)) return
      const marker = findSyntheticMarker(part.text)
      if (marker) {
        rec.ignoredMessageIds.add(part.messageID)
        discard(rec, "synthetic_text", { messageId: part.messageID, marker })
        return
      }
      if (part.messageID === rec.currentUserTurnId) appendUserText(rec, part.messageID, part.text ?? "")
      return
    }
    if (part.type === "tool") {
      const input = part.state?.input ?? {}
      const firstSight = !rec.knownToolCallIds.has(part.callID)
      if (firstSight) {
        rec.knownToolCallIds = rec.knownToolCallIds ?? new RingIdSet(256)
        rec.knownToolCallIds.add(part.callID)
        if (part.tool === "task" && isAdviserSubagent(input.subagent_type)) {
          recordAdviserCall(rec, "task", input.subagent_type)
          log.write({ kind: "adviser_call", sessionId: rec.id, tool: "task", name: input.subagent_type, turn: rec.turnCount })
        } else if (part.tool === "acp_run" && isAdviserSubagent(input.agent)) {
          recordAdviserCall(rec, "acp_run", input.agent)
          log.write({ kind: "adviser_call", sessionId: rec.id, tool: "acp_run", name: input.agent, turn: rec.turnCount })
        } else if (part.tool === "todowrite" && Array.isArray(input.todos)) {
          recordTodowrite(rec, input.todos)
        }
      }
      if (part.tool === "task" && part.state?.status === "completed") {
        recordTaskCompleted(rec, "task_tool")
      }
    }
  }

  const handleEvent = async ({ event }) => {
    try {
      routeEvent(event)
    } catch (err) {
      try {
        log.write({ kind: "internal_error", where: "event", error: String(err?.message ?? err) })
      } catch {
        /* never propagate */
      }
    }
  }

  // ------------- transform hook (single injection point, T1a) -------------

  function findSessionId(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const sid = messages[i]?.info?.sessionID
      if (typeof sid === "string") return sid
    }
    return null
  }

  const handleTransform = async (_input, output) => {
    const t0 = Date.now()
    try {
      const messages = output?.messages
      if (!Array.isArray(messages) || messages.length === 0) return
      const sessionId = findSessionId(messages)
      const rec = sessionId ? led.recall(sessionId) : null
      if (!rec) {
        log.write({ kind: "transform_skip", reason: "no_ledger_entry" })
        return
      }
      if (rec.blacklisted) {
        log.write({ kind: "transform_skip", sessionId, reason: "blacklisted", detail: rec.blacklistReason })
        return // never touch subagent/judge/child model requests
      }
      if (rec.unstable) {
        expireAll(rec, rec.unstable)
        log.write({ kind: "transform_skip", sessionId, reason: `unstable_${rec.unstable}` })
        return // fail-safe: compaction/revert — default no intervention
      }
      if (!rec.currentUserTurnId) {
        log.write({ kind: "transform_skip", sessionId, reason: "no_real_user_turn" })
        return
      }

      // T1a: bounded local deterministic evaluation inside the request hook.
      rec.currentEvidenceHash = evidenceHash(getUserTurnText(rec))
      const results = evaluateAllRules(rec, cfg)
      for (const r of results) {
        if (r.kind === "hit") {
          const offered = offerCandidate(rec, r.ruleId, r.evidence, cfg)
          if (offered.discard) {
            discard(rec, offered.discard, { ruleId: r.ruleId, turn: rec.turnCount })
          } else {
            rec.ruleHits += 1
            log.write({
              kind: "l0_hit",
              sessionId: rec.id,
              ruleId: r.ruleId,
              ruleVersion: offered.candidate.ruleVersion,
              candidateId: offered.candidate.id,
              turn: rec.turnCount,
              deduped: offered.deduped === true,
              evidence: r.evidence,
            })
          }
        } else {
          discard(rec, r.reason, { ruleId: r.ruleId, turn: rec.turnCount })
        }
      }
      log.write({
        kind: "transform_eval",
        sessionId: rec.id,
        mode: cfg.mode,
        turn: rec.turnCount,
        messages: messages.length,
        durMs: Date.now() - t0,
        openCandidates: rec.candidates.filter((c) => c.status === "candidate").length,
      })

      if (cfg.mode !== "inject") return // observe: log only, zero injection

      // Phase two: validate + inject at most ONE nudge per model request.
      if (rec.injectedCount >= cfg.injectPerSessionMax) {
        countDiscard(rec, "inject_budget_exhausted")
        log.write({ kind: "l0_discard", sessionId: rec.id, reason: "inject_budget_exhausted", turn: rec.turnCount })
        return
      }
      for (const candidate of rec.candidates) {
        if (candidate.status !== "candidate") continue
        if (!isBindingValid(candidate, rec)) {
          expireCandidate(candidate, "binding_stale")
          discard(rec, "binding_stale", { ruleId: candidate.ruleId, candidateId: candidate.id, turn: rec.turnCount })
          continue
        }
        const text = formatNudge(candidate, cfg.nudgeMaxChars)
        messages.push(buildInjectedMessage(text, sessionId))
        markInjected(candidate)
        rec.injectedCount += 1
        // "injected" only means: joined this request's context. Not provider
        // success, not orchestrator adoption (design doc §3 状态语义).
        log.write({
          kind: "injected",
          sessionId: rec.id,
          ruleId: candidate.ruleId,
          candidateId: candidate.id,
          turn: rec.turnCount,
          len: text.length,
          durMs: Date.now() - t0,
        })
        break
      }
    } catch (err) {
      try {
        log.write({ kind: "internal_error", where: "transform", error: String(err?.message ?? err) })
      } catch {
        /* never propagate */
      }
    }
  }

  return {
    event: handleEvent,
    "experimental.chat.messages.transform": handleTransform,
  }
}

export default SupervisorNudge
