import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { assertBehaviorPath, behaviorPath, readBehaviorSettings } from "../plugin/behavior-settings.mjs"
export { readBehaviorSettings }

function fail(code) { const error = new Error(code); error.code = code; throw error }

export function behaviorContributions(options = {}) {
  const result = readBehaviorSettings(options)
  return { ...result, duplicateObservation: options.standaloneClaudeAdvisorVisible === true ? "observed" : "unknown", diagnostics: [...result.diagnostics, ...(options.standaloneClaudeAdvisorVisible === true ? ["DUPLICATE_CLAUDE_ADVISOR"] : [])] }
}

// Dedicated single-file transaction, intentionally separate from native config WAL.
export function updateBehaviorSettings(options = {}) {
  if (typeof options.claudeGuardEnabled !== "boolean" || typeof options.revision !== "string") fail("INVALID_REQUEST")
  if (options.claudeGuardEnabled && options.confirmEnable !== true) fail("CONFIRMATION_REQUIRED")
  const target = behaviorPath(options)
  const directory = path.dirname(target)
  let lock, temporary
  try {
    assertBehaviorPath(target)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertBehaviorPath(target)
    try { lock = fs.openSync(path.join(directory, "behavior.lock"), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600) }
    catch (error) { if (error.code === "EEXIST") fail("BUSY"); throw error }
    const before = readBehaviorSettings(options)
    if (before.source === "blocked") fail("INVALID_OR_UNSAFE_BEHAVIOR_SETTINGS")
    if (before.revision !== options.revision) fail("CONFLICT")
    const token = randomUUID()
    temporary = path.join(directory, `.behavior-${token}.tmp`)
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, claudeGuardEnabled: options.claudeGuardEnabled, writerTransformEnabled: false }) + "\n"); fs.fsyncSync(fd) }
    finally { fs.closeSync(fd) }
    assertBehaviorPath(target)
    if (readBehaviorSettings(options).revision !== before.revision) fail("CONFLICT")
    fs.renameSync(temporary, target)
    temporary = undefined
    const dir = fs.openSync(directory, fs.constants.O_RDONLY)
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    return behaviorContributions(options)
  } catch (error) {
    if (["BUSY", "CONFLICT", "INVALID_OR_UNSAFE_BEHAVIOR_SETTINGS"].includes(error.code)) throw error
    fail("BEHAVIOR_WRITE_FAILED")
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary) } catch {} }
    if (lock !== undefined) {
      fs.closeSync(lock)
      try { fs.unlinkSync(path.join(directory, "behavior.lock")) } catch {}
    }
  }
}
