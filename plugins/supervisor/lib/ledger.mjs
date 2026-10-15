// Per-session ledger (spec §2 账本, bounded): real-user-turn counting,
// decision-version counting (assistant turns), adviser-call records,
// latest todowrite snapshot, L0 hits / discard-reason counters.
// The session map is an LRU capped at sessionLruMax; per-session event
// ring buffer capped at ringBufferMax.

import { createHash } from "node:crypto"

// OMO subagent child sessions are announced as `subagent.*` events.
export const SUBAGENT_EVENT_PREFIX = "subagent."

export const ADVISER_BASE = new Set(["oracle", "council", "claude"])

export function isAdviserSubagent(name) {
  if (typeof name !== "string" || name.length === 0) return false
  if (ADVISER_BASE.has(name)) return true
  if (name.startsWith("councillor-")) return true
  return false
}

// Bounded FIFO set used for callID / messageID dedupe.
export class RingIdSet {
  constructor(cap) {
    this.cap = cap
    this.map = new Map()
  }
  add(id) {
    if (typeof id !== "string") return
    if (this.map.has(id)) return
    this.map.set(id, true)
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }
  has(id) {
    return this.map.has(id)
  }
  get size() {
    return this.map.size
  }
}

export function createLedger(cfg) {
  const sessions = new Map() // sessionId -> record (insertion order = LRU order)

  function ensure(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return null
    let rec = sessions.get(sessionId)
    if (rec) {
      sessions.delete(sessionId)
      sessions.set(sessionId, rec)
      return rec
    }
    rec = freshRecord(sessionId)
    sessions.set(sessionId, rec)
    while (sessions.size > cfg.sessionLruMax) {
      const oldest = sessions.keys().next().value
      sessions.delete(oldest)
    }
    return rec
  }

  function recall(sessionId) {
    // recall refreshes recency WITHOUT creating entries: transform requests
    // for sessions we never observed (or evicted) must stay untouched.
    if (typeof sessionId !== "string" || sessionId.length === 0) return null
    const rec = sessions.get(sessionId)
    if (!rec) return null
    sessions.delete(sessionId)
    sessions.set(sessionId, rec)
    return rec
  }

  function drop(sessionId) {
    if (typeof sessionId === "string") sessions.delete(sessionId)
  }

  function size() {
    return sessions.size
  }

  return { ensure, recall, drop, size }
}

export function freshRecord(sessionId) {
  return {
    id: sessionId,
    createdAtTs: Date.now(),
    // identity contract: root sessions only
    blacklisted: false,
    blacklistReason: null,
    // turn versioning
    turnCount: 0,
    currentUserTurnId: null,
    currentUserText: "",
    currentEvidenceHash: null,
    knownUserIds: new RingIdSet(256), // already-classified user message ids
    ignoredMessageIds: new RingIdSet(256), // synthetic/internal user message ids
    assistantTurnCount: 0,
    decisionIds: new RingIdSet(256),
    // adviser calls
    adviserCallsTotal: 0,
    adviserCallsThisTurn: 0,
    // todowrite snapshot
    todowrites: 0,
    lastTodo: null, // { todos, turnCount, assistantTurnCount, ts }
    // task completion signals (rule B1)
    tasksCompleted: 0,
    lastTaskCompleted: null, // { source, turnCount, assistantTurnCount, todowrites, ts, resolved }
    // L0 outcomes
    ruleHits: 0,
    injectedCount: 0,
    candidates: [], // bounded by candidatesCap in offerCandidate()
    discards: {}, // reason -> count
    events: [], // ring buffer of {ts, type}
    knownToolCallIds: new RingIdSet(256),
    unstable: null, // "revert" | "compacted" — fail-safe latch
  }
}

export function observeRing(rec, type, cap = 500) {
  rec.events.push({ ts: Date.now(), type })
  if (rec.events.length > cap) rec.events.splice(0, rec.events.length - cap)
}

export function countDiscard(rec, reason) {
  rec.discards[reason] = (rec.discards[reason] ?? 0) + 1
}

export function blacklist(rec, reason) {
  if (rec.blacklisted) return false
  rec.blacklisted = true
  rec.blacklistReason = reason
  countDiscard(rec, `blacklist_${reason}`)
  return true
}

// New REAL user input: new binding version → all open candidates expire.
export function newRealUserTurn(rec, messageId) {
  if (rec.currentUserTurnId === messageId) return false
  if (rec.currentUserTurnId) expireAllInternal(rec, "new_user_input")
  rec.turnCount += 1
  rec.currentUserTurnId = messageId
  rec.currentUserText = ""
  rec.currentEvidenceHash = null
  rec.adviserCallsThisTurn = 0
  return true
}

export function appendUserText(rec, messageId, text) {
  if (messageId !== rec.currentUserTurnId) return
  if (typeof text !== "string") return
  rec.currentUserText += text
  rec.currentEvidenceHash = evidenceHash(rec.currentUserText)
}

export function getUserTurnText(rec) {
  return rec.currentUserText
}

export function recordAssistantDecision(rec, messageId) {
  if (rec.decisionIds.has(messageId)) return
  rec.decisionIds.add(messageId)
  rec.assistantTurnCount += 1
}

export function recordAdviserCall(rec, tool, name) {
  rec.adviserCallsTotal += 1
  rec.adviserCallsThisTurn += 1
  rec.lastAdviserCall = { tool, name, turnCount: rec.turnCount, ts: Date.now() }
}

export function recordTodowrite(rec, todos) {
  rec.todowrites += 1
  rec.lastTodo = {
    todos,
    turnCount: rec.turnCount,
    assistantTurnCount: rec.assistantTurnCount,
    todowrites: rec.todowrites,
    ts: Date.now(),
  }
}

export function recordTaskCompleted(rec, source) {
  rec.tasksCompleted += 1
  rec.lastTaskCompleted = {
    source,
    turnCount: rec.turnCount,
    assistantTurnCount: rec.assistantTurnCount,
    todowrites: rec.todowrites,
    ts: Date.now(),
    resolved: false, // set true once rule B1 evaluated this signal
  }
}

export function evidenceHash(text) {
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 16)
}

// Internal use by newRealUserTurn (already imported lazily to avoid cycle).
function expireAllInternal(rec, reason) {
  let n = 0
  for (const c of rec.candidates) {
    if (c.status === "candidate") {
      c.status = "expired"
      c.expiredReason = reason
      n += 1
    }
  }
  return n
}
