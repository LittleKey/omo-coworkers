// Synthetic-text / internal-metadata filters (spec §2 事件过滤).
// All matches are deterministic substring/regex checks — no LLM, no net.

// OMO subagent child session events: `subagent.session.created` etc.
export { SUBAGENT_EVENT_PREFIX } from "./ledger.mjs"

const SYNTHETIC_MARKERS = [
  "[system-reminder",
  "[blackboard",
  "[ACP",
  "SLIM_INTERNAL_INITIATOR",
  "Background Job Board",
  "PHASE_REMINDER",
]

export function findSyntheticMarker(text) {
  if (typeof text !== "string" || text.length === 0) return null
  for (const marker of SYNTHETIC_MARKERS) {
    if (text.includes(marker)) return marker
  }
  // `bcp`: case-sensitive word-boundary match — real markers are lowercase
  // ("bcp:store", "<!-- bcp"), while "BCP 47" stays legitimate text.
  if (/\bbcp\b/.test(text)) return "bcp"
  // `dcp` prefix/markers: line-initial dcp tag or a [dcp...] / (dcp...) marker.
  if (/(^|\n)\s*dcp[:\s]|[\[(]dcp[.\])]/.test(text)) return "dcp"
  return null
}

// Internal metadata keys on user messages (top-level or inside .metadata).
const INTERNAL_METADATA_KEYS = [
  "internalInitiator",
  "backgroundJobBoard",
  "phaseReminder",
  "deepworkGoal",
]

// Supervisor's own synthetic messages (R32): our injected nudge messages
// carry info.metadata.supervisor = { kind: "nudge", ruleId, ... }.
// Recognition is metadata-FIRST; the [supervisor-nudge] text prefix remains
// a fallback. External synthetic messages must NOT be assumed to carry
// metadata — the text checks stay authoritative for those.
export const SUPERVISOR_NUDGE_PREFIX = "[supervisor-nudge]"

// Text-prefix fallback: recognizes supervisor nudge messages that predate
// the metadata field (or lost it) by their leading marker. Returns the
// matched part text, or null.
export function findSupervisorTextPrefix(info) {
  if (!info || typeof info !== "object" || !Array.isArray(info.parts)) return null
  for (const part of info.parts) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" && part.text.startsWith(SUPERVISOR_NUDGE_PREFIX)) {
      return part.text
    }
  }
  return null
}
export function findSupervisorMetadata(info) {
  if (!info || typeof info !== "object") return null
  // Same loose lookup as findInternalMetadataKey: the supervisor key may sit
  // on info itself or inside info.metadata, case-insensitively (host shape).
  for (const obj of [info, info.metadata]) {
    if (!obj || typeof obj !== "object") continue
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase() !== "supervisor") continue
      const sup = obj[key]
      if (sup && typeof sup === "object" && typeof sup.kind === "string" && sup.kind.length > 0) return sup
    }
  }
  return null
}

export function findInternalMetadataKey(info) {
  if (!info || typeof info !== "object") return null
  const lower = new Set()
  for (const obj of [info, info.metadata]) {
    if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj)) lower.add(key.toLowerCase())
    }
  }
  for (const key of INTERNAL_METADATA_KEYS) {
    if (lower.has(key.toLowerCase())) return key
  }
  return null
}

// Advisor-named sessions: councillor-* / judge in title or name.
export function isAdvisorSessionName(title) {
  if (typeof title !== "string" || title.length === 0) return false
  const t = title.toLowerCase()
  if (t.startsWith("councillor-")) return true
  if (t.includes("judge")) return true
  return false
}

// Task terminal signals (rule B1 evidence): a user-side delivery shaped like
// `<task ...state="completed">` or a background task terminal marker.
export function findTaskCompletedSignal(text) {
  if (typeof text !== "string" || text.length === 0) return null
  if (/<task\s[^>]*state=["']completed["']/i.test(text)) return "task_delivery"
  if (/background\s+task[^\n]{0,80}(completed|finished|done)/i.test(text)) return "background_terminal"
  if (/task\s*[#]?\w*[^\n]{0,40}\bstate["']?\s*[:=]\s*["']?completed/i.test(text)) return "task_state_line"
  return null
}
