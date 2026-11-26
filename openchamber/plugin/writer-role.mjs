import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"

// Only these verified legacy literals are migration inputs, never user config.
const legacyAudience = `# Audience and dispatch

- Default audience: software developer; avoid teaching familiar basics.
- Dispatch in the recipient's working language with readable sources, constraints and expected output; send only missing context/deltas to continuing sessions. Claude's dedicated routing specifies its transport and output contract.
- Use document-writer for formal-document wording.`
const legacyRouting = "Use document-writer for formal documents: MODE: WRITE for creation/body edits; MODE: REVIEW for document review. Reuse a suitable writer for revisions, never to independently review its own output. Keep internal plans/state in the main session; independent platform work goes to lark-operator. Follow the main-session review policy."
const legacyOracle = "- Tie findings to the inspected version, coverage and limits; include severity, location and evidence/gap. Send purely editorial formal-document issues to document-writer unless meaning changes."

const files = [
  ["document-writer.md", "36ef44de293053e5fbeb743851d63ba5c9965a85c78147e2b40dacc50f71fd9d"],
  ["routing.json", "9de5fb6d0ee5244e6398424326620ef557bfc478beef8a793d36d5f1186da115"],
  ["audience.md", "0e5c2d7a7ad22309dab93659b43224f7000143219813356712179c532f5c67a3"],
  ["oracle-line.txt", "1cbc333a6b9d0b6a2c868fa1bb3191d369f9c8a4b68f18b2e83c202aa58b0c28"],
]

// Offsets let us replace known slots without reformatting unrelated text.
// Fenced examples are inert, including headings and writer mentions inside them.
function lines(text) {
  const result = []
  let offset = 0, fence
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const body = raw.replace(/\r?\n$/, "")
    const marker = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    let active = !fence
    if (fence) {
      active = false
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }
      active = false
    }
    result.push({ start: offset, end: offset + raw.length, body, active })
    offset += raw.length
  }
  // Appending inside an unfinished example would hide the route and break replay.
  if (fence) conflict()
  return result
}

function conflict() { throw new Error("ROUTING_CONFLICT") }
function append(text, value) {
  return text + (text ? (text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n") : "") + value + "\n"
}
function replace(text, slot, value) {
  return text.slice(0, slot.start) + value + text.slice(slot.end)
}
function mentionsWriter(text) {
  return lines(text).some(line => line.active && line.body.includes("document-writer"))
}
function paragraphs(text) {
  const result = []
  let current
  for (const line of lines(text)) {
    if (!line.active || !line.body.trim() || /^#{1,6} /.test(line.body)) {
      if (current) result.push(current)
      current = undefined
    } else {
      if (!current) current = { start: line.start, end: line.start + line.body.length }
      current.end = line.start + line.body.length
    }
  }
  if (current) result.push(current)
  return result
}

function mergeOrchestrator(text, payload) {
  const ls = lines(text)
  const headings = ls.filter(line => line.active && /^# /.test(line.body))
  const audience = headings.filter(line => line.body === "# Audience and dispatch")
  if (audience.length > 1) conflict()
  const edits = []
  if (audience.length) {
    const start = audience[0].start
    const next = headings.find(line => line.start > start)
    const end = (next ? next.start : text.length)
    const body = text.slice(start, end).replace(/\s+$/, "")
    if (body !== legacyAudience && body !== payload.audience) conflict()
    edits.push({ start, end: start + body.length, value: payload.audience })
  }
  // Mask only the verified slot; every other active writer rule must be known.
  const masked = edits.length ? replace(text, edits[0], "") : text
  const slots = paragraphs(masked).filter(slot => {
    const body = masked.slice(slot.start, slot.end)
    return body === legacyRouting || body === payload.routing.orchestratorPrompt
  })
  if (slots.length > 1) conflict()
  let remainder = masked
  if (slots.length) remainder = replace(masked, slots[0], "")
  if (mentionsWriter(remainder)) conflict()
  let merged = edits.length ? replace(text, edits[0], payload.audience) : text
  // Re-find the paragraph after the Audience edit so original offsets stay local.
  const slot = paragraphs(merged).find(slot => {
    const body = merged.slice(slot.start, slot.end)
    return body === legacyRouting || body === payload.routing.orchestratorPrompt
  })
  // Never append after losing a slot that preflight already recognized.
  if (Boolean(slots.length) !== Boolean(slot)) conflict()
  if (slot) {
    merged = replace(merged, slot, payload.routing.orchestratorPrompt)
  } else if (audience.length && !headings.some(line => line.start > audience[0].start)) {
    // Keep a terminal Audience an exact slot on replay: a routing paragraph
    // appended after it would become unrecognized custom Audience content.
    const start = audience[0].start
    merged = append(merged.slice(0, start), payload.routing.orchestratorPrompt) + "\n" + merged.slice(start)
  } else {
    merged = append(merged, payload.routing.orchestratorPrompt)
  }
  if (!audience.length) merged = append(merged, payload.audience)
  return merged
}

function mergeOracle(text, payload) {
  const slots = lines(text).filter(line => line.active && (line.body === legacyOracle || line.body === payload.oracle))
  if (slots.length > 1) conflict()
  const slot = slots[0] && { start: slots[0].start, end: slots[0].start + slots[0].body.length }
  if (mentionsWriter(slot ? replace(text, slot, "") : text)) conflict()
  return slot ? replace(text, slot, payload.oracle) : append(text, payload.oracle)
}

export async function setupWriterRole(ctx) {
  const seen = new Set()
  const warn = (code, role = "document-writer") => {
    const key = `${code}:${role}`
    if (seen.has(key)) return
    seen.add(key)
    console.warn(`[omo-coworkers/writer-role] ${code} role=${role}; reconcile existing roles/routing and native host support before retrying.`)
  }
  if (typeof ctx?.agent?.transform !== "function") {
    warn("NATIVE_AGENT_TRANSFORM_UNAVAILABLE")
    return
  }
  let payload
  try {
    const content = await Promise.all(files.map(async ([name, hash]) => {
      const raw = await readFile(new URL(`./roles/${name}`, import.meta.url))
      if (createHash("sha256").update(raw).digest("hex") !== hash) throw new Error("hash")
      return raw.toString("utf8")
    }))
    const [writer, routing, audience, oracle] = content
    const parsed = JSON.parse(routing)
    if (typeof parsed.description !== "string" || typeof parsed.orchestratorPrompt !== "string") throw new Error("routing")
    payload = { writer, routing: parsed, audience: audience.trimEnd(), oracle: oracle.trimEnd() }
  } catch {
    warn("ROLE_PAYLOAD_INVALID")
    return
  }
  try {
    await ctx.agent.transform(editor => {
      if (typeof editor?.get !== "function" || typeof editor?.update !== "function") {
        warn("NATIVE_AGENT_TRANSFORM_UNAVAILABLE")
        return
      }
      const writer = editor.get("document-writer")
      if (!writer || writer.disabled === true) {
        warn("WRITER_PREREQUISITE_MISSING")
        return
      }
      if (!["subagent", "all"].includes(writer.mode)) {
        warn("WRITER_MODE_INCOMPATIBLE")
        return
      }
      const pending = []
      for (const [id, merge] of [["orchestrator", mergeOrchestrator], ["oracle", mergeOracle]]) {
        const target = editor.get(id)
        if (!target) {
          warn("ROUTING_TARGET_ABSENT", id)
          continue
        }
        if (target.system !== undefined && typeof target.system !== "string") {
          warn("ROUTING_CONFLICT", id)
          return
        }
        try {
          const system = merge(target.system ?? "", payload)
          if (system !== target.system) pending.push([id, system])
        } catch {
          warn("ROUTING_CONFLICT", id)
          return
        }
      }
      // All predictable conflicts are checked before the first mutation.
      editor.update("document-writer", agent => {
        agent.system = payload.writer
        agent.description = payload.routing.description
      })
      for (const [id, system] of pending) editor.update(id, agent => { agent.system = system })
    })
  } catch {
    // Native exceptions are not a transaction; do not claim rollback.
    warn("ROLE_REGISTRATION_FAILED")
  }
}
