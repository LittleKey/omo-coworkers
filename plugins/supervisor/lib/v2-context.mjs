// Native v2 request messages have {id, role, content}, not v1 {info, parts}.
// Replay newly observed request content into the existing rule engine. This
// also recovers observation after plugin hot reload without reading history.
import { RingIdSet } from "./ledger.mjs"

export function createV2ContextHandler(core, getSession) {
  const seenBySession = new Map()
  return async (event) => {
    if (!event?.sessionID || !Array.isArray(event.messages)) return
    try {
      // Read parent identity before observation: never intervene in a child.
      const session = await getSession(event.sessionID)
      if (session?.id !== event.sessionID) return
      await core.v2.onEvent({ type: "session.created", properties: { info: session } })
      let seen = seenBySession.get(session.id)
      if (!seen) {
        seen = new RingIdSet(4096)
        seenBySession.set(session.id, seen)
        if (seenBySession.size > core.cfg.sessionLruMax) seenBySession.delete(seenBySession.keys().next().value)
      }
      for (const message of event.messages) {
        if (!message.id || !Array.isArray(message.content)) continue
        // Machine-only user messages must not create a new real-user turn.
        if (message.role === "user" && message.content.length && message.content.every(p => p.synthetic === true)) continue
        const fresh = !seen.has(`message:${message.id}`)
        if (fresh) {
          seen.add(`message:${message.id}`)
          await core.v2.onEvent({ type: "message.updated", properties: { info: { ...message, sessionID: session.id } } })
        }
        for (const part of message.content) {
          let mapped
          if (part.type === "text" && fresh) {
            mapped = part
          } else if ((part.type === "tool-call" || part.type === "tool-result") && part.toolCallId) {
            const key = `${part.type}:${part.toolCallId}`
            if (seen.has(key)) continue
            seen.add(key)
            mapped = { type: "tool", tool: part.toolName, callID: part.toolCallId,
              state: { input: part.input ?? {}, status: part.type === "tool-call" ? "running" : "completed" } }
          }
          if (mapped) await core.v2.onEvent({ type: "message.part.updated", properties: {
            part: { ...mapped, messageID: message.id, sessionID: session.id },
          } })
        }
      }
      const messages = event.messages.map(m => ({ info: { ...m, sessionID: session.id }, parts: m.content }))
      const count = messages.length
      await core.v2.onContext({ messages })
      // Append only; leave original request messages and content untouched.
      for (const message of messages.slice(count)) {
        event.messages.push({ ...message.info, content: message.parts })
      }
    } catch (error) {
      core.log.write({ kind: "internal_error", where: "v2.context", error: String(error?.message ?? error) })
    }
  }
}
