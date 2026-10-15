// Candidate lifecycle (spec §2): candidate → injected / expired.
// Binding = (sessionId, userTurnId, turnCount, evidenceHash).
// Same binding + same ruleId dedupes; any new real user input or evidence
// change expires all open candidates; no cross-turn carry-over/injection.

import { RULE_VERSION } from "./rules.mjs"

export function makeBinding(rec) {
  return {
    sessionId: rec.id,
    userTurnId: rec.currentUserTurnId,
    turnCount: rec.turnCount,
    evidenceHash: rec.currentEvidenceHash,
  }
}

export function sameBinding(a, b) {
  return (
    a.userTurnId === b.userTurnId &&
    a.turnCount === b.turnCount &&
    a.evidenceHash === b.evidenceHash
  )
}

// Returns {candidate, deduped} on success, or {discard: reason} when the
// candidate must not be offered again (same binding already injected).
export function offerCandidate(rec, ruleId, evidence, cfg) {
  const binding = makeBinding(rec)
  const existing = rec.candidates.find(
    (c) => c.ruleId === ruleId && sameBinding(c.binding, binding),
  )
  if (existing) {
    if (existing.status === "injected") {
      return { discard: "already_injected_same_binding" }
    }
    if (existing.status === "candidate") {
      return { candidate: existing, deduped: true }
    }
    // expired under the same binding: treat as deduped, not re-offered
    return { discard: "expired_same_binding" }
  }
  const candidate = {
    id: `sn-${rec.id}-${binding.turnCount}-${ruleId}`,
    ruleId,
    ruleVersion: RULE_VERSION,
    binding,
    evidence: evidence ?? null,
    status: "candidate",
    createdTs: Date.now(),
    injectedTs: null,
    expiredReason: null,
  }
  rec.candidates.push(candidate)
  while (rec.candidates.length > cfg.candidatesCap) {
    rec.candidates.shift()
  }
  return { candidate, deduped: false }
}

export function expireAll(rec, reason) {
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

export function expireCandidate(candidate, reason) {
  if (candidate.status !== "candidate") return false
  candidate.status = "expired"
  candidate.expiredReason = reason
  return true
}

// T1a validation at injection time: the binding captured at offer time must
// still be the session's current turn + evidence.
export function isBindingValid(candidate, rec) {
  return sameBinding(candidate.binding, makeBinding(rec))
}

export function markInjected(candidate) {
  candidate.status = "injected"
  candidate.injectedTs = Date.now()
}
