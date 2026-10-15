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
