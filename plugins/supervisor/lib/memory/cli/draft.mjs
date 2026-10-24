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
        "You are an AGENTS.md rule-drafting assistant. From the candidate correction events, draft one durable agent behavior rule. Requirements: imperative sentences, followable long-term, no references to specific sessions, at most 10 lines, and no HTML comments or markers of any kind.",
    },
    {
      role: "user",
      content:
        `candidate title: ${issue.title}\n` +
        `topic: ${issue.topic ?? "unknown"}\n` +
        `classification: ${issue.classification?.kind ?? "unknown"}\n` +
        `correction excerpts (this candidate only, ${events.length} in total):\n${lines.join("\n") || "(none)"}\n` +
        `Output the rule body itself, nothing else.`,
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
      return { status: "failed", error: "model returned empty content" }
    }
    return { status: "ok", text }
  } catch (e) {
    if (ac.signal.aborted) return { status: "timeout", error: `no response within ${timeoutMs}ms` }
    return { status: "failed", error: String(e?.message ?? e) }
  } finally {
    clearTimeout(timer)
  }
}
