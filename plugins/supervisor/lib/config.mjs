// supervisor-nudge plugin options (spec §2/§4, L0 scope).
// Options come from the second tuple element of the opencode.json plugin entry:
//   "plugin": ["file:///.../plugins/supervisor/index.mjs", { "mode": "inject" }]
// Everything is bounded; unknown keys are ignored.

import os from "node:os"
import path from "node:path"

export const DEFAULTS = {
  mode: "observe",
  injectPerSessionMax: 3,
  nudgeMaxChars: 1200,
  sessionLruMax: 200,
  ringBufferMax: 500,
  logMaxBytes: 5 * 1024 * 1024,
  candidatesCap: 20,
  assistantDecisionsStale: 2, // rule B: N assistant decisions without todowrite
  turnsDormant: 2, // rule B: N user turns without related todowrite
  evidenceMaxChars: 200,
}

export function defaultLogPath() {
  // os.homedir() honors $HOME on linux, so an isolated HOME in E2E reroutes
  // the observe log automatically (spec: 测试时随隔离 HOME 走).
  return path.join(
    os.homedir(),
    ".local/share/opencode/storage/plugin/supervisor/log.jsonl",
  )
}

export function resolveConfig(options) {
  const o = options && typeof options === "object" ? options : {}
  const mode = o.mode === "inject" ? "inject" : "observe"
  return {
    mode,
    logPath: typeof o.logPath === "string" && o.logPath ? o.logPath : defaultLogPath(),
    injectPerSessionMax: intOption(o.injectPerSessionMax, DEFAULTS.injectPerSessionMax, 1, 1000),
    nudgeMaxChars: intOption(o.nudgeMaxChars, DEFAULTS.nudgeMaxChars, 200, 8000),
    sessionLruMax: intOption(o.sessionLruMax, DEFAULTS.sessionLruMax, 1, 100000),
    ringBufferMax: intOption(o.ringBufferMax, DEFAULTS.ringBufferMax, 10, 100000),
    logMaxBytes: intOption(o.logMaxBytes, DEFAULTS.logMaxBytes, 64 * 1024, 1024 * 1024 * 1024),
    candidatesCap: intOption(o.candidatesCap, DEFAULTS.candidatesCap, 1, 1000),
    assistantDecisionsStale: intOption(o.assistantDecisionsStale, DEFAULTS.assistantDecisionsStale, 1, 100),
    turnsDormant: intOption(o.turnsDormant, DEFAULTS.turnsDormant, 1, 100),
    evidenceMaxChars: intOption(o.evidenceMaxChars, DEFAULTS.evidenceMaxChars, 20, 2000),
  }
}

function intOption(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}
