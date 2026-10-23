// `digest --draft <issueId>` — ONE attempt to draft a rule body for ONE
// candidate via an OpenAI-compatible chat-completions endpoint (newapi,
// glm-5.3). Privacy envelope (m1-plan D-deck): the request carries ONLY this
// candidate's events + excerpts — never the whole store. One attempt: any
// failure/timeout → tell the user to draft manually; no retry, no blocking of
// plain digest, failure counted. Never throws.
export const DRAFT_TIMEOUT_MS = 30_000

export function draftEnv(env) {
  return {
    apiKey: typeof env.SUPERVISOR_MEMORY_DRAFT_API_KEY === "string" && env.SUPERVISOR_MEMORY_DRAFT_API_KEY.length > 0
      ? env.SUPERVISOR_MEMORY_DRAFT_API_KEY
      : null,
    baseUrl: (env.SUPERVISOR_MEMORY_DRAFT_BASE_URL || "http://10.126.126.10:3000/v1").replace(/\/+$/, ""),
    model: env.SUPERVISOR_MEMORY_DRAFT_MODEL || "glm-5.3",
  }
}

/** Prompt = this candidate's events + excerpts, nothing else. */
export function buildDraftPrompt(issue, events) {
  const lines = []
  for (const e of events) {
    lines.push(`- [${e.id}] ${(e.evidence?.excerpt ?? "").replace(/\s+/g, " ").slice(0, 500)}`)
  }
  return [
    {
      role: "system",
      content:
        "你是 AGENTS.md 规则草稿助手。根据候选纠偏事件起草一条稳定的 agent 行为规则。要求: 祈使句、可长期遵循、不引用具体会话、不超过 10 行、不要输出任何 HTML 注释或 marker。",
    },
    {
      role: "user",
      content:
        `候选标题: ${issue.title}\n` +
        `主题: ${issue.topic ?? "未知"}\n` +
        `分类: ${issue.classification?.kind ?? "未知"}\n` +
        `纠偏摘录(仅此候选, 共 ${events.length} 条):\n${lines.join("\n") || "(无)"}\n` +
        `请只输出规则正文本身。`,
    },
  ]
}

/**
 * One draft attempt. Returns
 *   {status:"no-key"} — caller prints skip message (exit 0, no network)
 *   {status:"ok", text}
 *   {status:"failed", error} | {status:"timeout", error}
 */
export async function draftOnce({ issue, events, env, fetchImpl, timeoutMs = DRAFT_TIMEOUT_MS }) {
  if (!env.apiKey) return { status: "no-key" }
  const doFetch = fetchImpl ?? fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await doFetch(`${env.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify({ model: env.model, messages: buildDraftPrompt(issue, events), stream: false }),
      signal: ac.signal,
    })
    if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` }
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== "string" || text.trim().length === 0) {
      return { status: "failed", error: "模型返回空内容" }
    }
    return { status: "ok", text }
  } catch (e) {
    if (ac.signal.aborted) return { status: "timeout", error: `超过 ${timeoutMs}ms 未响应` }
    return { status: "failed", error: String(e?.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}
