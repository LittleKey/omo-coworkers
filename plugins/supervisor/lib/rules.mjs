// L0 rule families — pure, deterministic, ledger×signal cross-checks
// (spec §2 候选生命周期, §4 L0 scope). No side effects: callers turn
// `{kind:"hit"}` results into candidates and `{kind:"discard"}` into
// discard-reason statistics.

export const RULE_VERSION = "l0-1"

export function evaluateAllRules(rec, cfg) {
  const out = []
  const a = evaluateRuleA(rec)
  if (a) out.push(a)
  const b = evaluateRuleB(rec, cfg)
  if (b) out.push(b)
  return out
}

// Rule A (oracle-dispatch suggestion): high-stakes path/command/contract
// signals in the current real user turn × zero adviser calls in the turn.
export function evaluateRuleA(rec) {
  const text = rec.currentUserText ?? ""
  if (text.length === 0) return null
  const signal = matchHighStakesSignal(text)
  if (!signal) return null
  if (rec.adviserCallsThisTurn > 0) {
    return { kind: "discard", ruleId: "A.oracle_dispatch", reason: "adviser_already_called" }
  }
  return { kind: "hit", ruleId: "A.oracle_dispatch", evidence: signal }
}

const HIGH_STAKES_PATTERNS = [
  { family: "credential_path", re: /(^|[\s"'`(=~])(\/etc\/(sudoers|passwd|shadow)|\.ssh\/|\/\.ssh\b|\.aws\/|\.gnupg|id_rsa|id_ed25519|\.env\b|\.netrc|credentials?\.json|secrets?\.json|\bsecrets?\/)/i },
  { family: "irreversible_command", re: /(^|[\s;&|(])(rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+|git\s+push\s+(-[a-zA-Z]*f|--force)|DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE|chmod\s+(-R\s+)?777|mkfs\b|dd\s+if=|>\s*\/dev\/sd[a-z])/i },
  { family: "contract_file", re: /(^|[\s"'`(])(package(-lock)?\.json|openapi\.ya?ml|swagger\.|\.proto\b|schema\.json|\.schema\.json|api\.d\.ts|public-api)/i },
  { family: "approval_sla", re: /\b(approval|approve|sign[- ]?off|SLA|production (deploy|release|launch)|go[- ]live|上线审批|发布审批)\b/i },
]

function matchHighStakesSignal(text) {
  for (const p of HIGH_STAKES_PATTERNS) {
    const m = p.re.exec(text)
    if (m) {
      const start = Math.max(0, m.index - 40)
      return {
        family: p.family,
        snippet: text.slice(start, Math.min(text.length, m.index + m[0].length + 40)).replace(/\s+/g, " ").trim(),
      }
    }
  }
  return null
}

// Rule B (TODO staleness), two sub-rules over the ledger snapshot:
//  B1 completion-sync: a task terminal signal arrived, todo still has
//     open items, and N assistant decisions passed without a todowrite.
//  B2 dormancy: an in_progress todo survived N user turns with no
//     todowrite at all since it was recorded.
export function evaluateRuleB(rec, cfg) {
  const todo = rec.lastTodo
  if (!todo || !Array.isArray(todo.todos) || todo.todos.length === 0) return null
  const openItems = todo.todos.filter((t) => t?.status === "in_progress" || t?.status === "pending")
  if (openItems.length === 0) return null

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

  if (rec.turnCount - todo.turnCount >= cfg.turnsDormant) {
    return {
      kind: "hit",
      ruleId: "B.todo_stale",
      evidence: {
        sub: "dormant",
        turnsSince: rec.turnCount - todo.turnCount,
        openItems: openItems.length,
      },
    }
  }
  return null
}
