// Nudge formatting + synthetic message construction (spec §2 注入契约).
// Append-only: we never rewrite existing parts. The injected part carries a
// [supervisor-nudge] prefix plus a binding summary; length capped.

// RULE_HINTS keys MUST equal the ruleId strings rules.mjs actually emits
// ("B.todo_stale" — dotted); an underscored key silently misses and every
// nudge falls into the generic fallback. unit.test.mjs asserts the two
// sides stay in sync. (The "A.oracle_dispatch" hint was removed when rule
// family A was retired 2026-10-23 after user labeling.)
const RULE_HINTS = {
  "B.todo_stale":
    "TODO 计划可能需要核对:按时间启发式,in_progress/pending 项已多轮未同步 todowrite(尚未证明计划确有错误)。建议核对 todowrite 或收敛计划。",
}

export function formatNudge(candidate, maxChars, evidenceMaxChars = 200) {
  const b = candidate.binding
  const hint = RULE_HINTS[candidate.ruleId] ?? "Supervisor L0 信号。"
  const lines = [
    "[supervisor-nudge]",
    `rule=${candidate.ruleId} v=${candidate.ruleVersion}`,
    `binding=session=${b.sessionId} userTurn=${b.userTurnId} turn=${b.turnCount} evidence=${b.evidenceHash}`,
  ]
  if (candidate.evidence && typeof candidate.evidence === "object") {
    lines.push(`signal=${candidate.evidence.family ?? candidate.evidence.sub ?? "unknown"}`)
    if (typeof candidate.evidence.snippet === "string" && candidate.evidence.snippet.length > 0) {
      const snippet = candidate.evidence.snippet.slice(0, evidenceMaxChars)
      lines.push(`context="${snippet}"`)
    }
  }
  lines.push(hint)
  let text = lines.join("\n")
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…"
  return text
}

// Shape matches the VERIFIED probe pattern (probe2/home/.config/opencode/plugin/probe.mjs):
// push { info: { id, role: "user" }, parts: [{ type: "text", text }] } — no
// extra fields. Appended AFTER existing messages; never rewrites them.
export function buildInjectedMessage(text, _sessionId) {
  return {
    info: { id: `msg_sn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, role: "user" },
    parts: [{ type: "text", text }],
  }
}
