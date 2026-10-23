// L0 rule family B — pure, deterministic, ledger×signal cross-checks
// (spec §2 候选生命周期, §4 L0 scope). No side effects: callers turn
// `{kind:"hit"}` results into candidates and `{kind:"discard"}` into
// discard-reason statistics. (Rule family A `oracle_dispatch` was retired
// 2026-10-23 after user labeling; see README — history rows in log.jsonl
// may still carry A.oracle_dispatch ruleIds and must stay readable.)

export const RULE_VERSION = "l0-1"

export function evaluateAllRules(rec, cfg) {
  const out = []
  const b = evaluateRuleB(rec, cfg)
  if (b) out.push(b)
  return out
}

// Rule B (TODO staleness), two sub-rules over the ledger snapshot:
//  B1 completion-sync: a task terminal signal arrived, todo still has
//     open items (in_progress OR pending), and N assistant decisions
//     passed without a todowrite.
//  B2 dormancy: an in_progress todo survived N user turns with no
//     todowrite at all since it was recorded. Contract (README B2 +
//     R29 Oracle review): pending NEVER counts toward dormancy — a
//     parked backlog item sitting across turns is not staleness.
export function evaluateRuleB(rec, cfg) {
  const todo = rec.lastTodo
  if (!todo || !Array.isArray(todo.todos) || todo.todos.length === 0) return null
  const openItems = todo.todos.filter((t) => t?.status === "in_progress" || t?.status === "pending")
  if (openItems.length === 0) return null
  const inProgressItems = todo.todos.filter((t) => t?.status === "in_progress")

  const sig = rec.lastTaskCompleted
  if (sig && !sig.resolved) {
    const decisionsSince = rec.assistantTurnCount - sig.assistantTurnCount
    const todoTouched = rec.todowrites !== sig.todowrites
    if (todoTouched) {
      sig.resolved = true // final verdict: user already resynced the plan
      return {
        kind: "discard",
        ruleId: "B.todo_stale",
        reason: "todo_updated_since_signal",
      }
    }
    if (decisionsSince < cfg.assistantDecisionsStale) {
      return null // verdict pending — keep observing, do not resolve the signal
    }
    sig.resolved = true // evaluate each terminal signal exactly once
    return {
      kind: "hit",
      ruleId: "B.todo_stale",
      evidence: {
        sub: "completion_sync",
        decisionsSince,
        openItems: openItems.length,
        signalSource: sig.source,
      },
    }
  }

  // B2 dormancy fires on in_progress items only; evidence reports the
  // in_progress count (pending items never trigger this sub-rule).
  if (inProgressItems.length > 0 && rec.turnCount - todo.turnCount >= cfg.turnsDormant) {
    return {
      kind: "hit",
      ruleId: "B.todo_stale",
      evidence: {
        sub: "dormant",
        turnsSince: rec.turnCount - todo.turnCount,
        openItems: inProgressItems.length,
      },
    }
  }
  return null
}
