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
  const lockPath = path.join(directory, "behavior.lock")
  try {
    assertBehaviorPath(target)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertBehaviorPath(target)
    if (fs.existsSync(lockPath)) {
      assertBehaviorPath(lockPath)
      const before = fs.lstatSync(lockPath)
      let owner
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) } catch { fail("BUSY") }
      if (!owner || Object.keys(owner).join() !== "pid" || !Number.isSafeInteger(owner.pid) || owner.pid < 1) fail("BUSY")
      try { process.kill(owner.pid, 0); fail("BUSY") }
      catch (error) { if (error.code !== "ESRCH") throw error }
      const after = fs.lstatSync(lockPath)
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) fail("BUSY")
      fs.unlinkSync(lockPath)
    }
    try { lock = fs.openSync(path.join(directory, "behavior.lock"), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600) }
    catch (error) { if (error.code === "EEXIST") fail("BUSY"); throw error }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid })); fs.fsyncSync(lock)
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
      try {
        const current = fs.lstatSync(lockPath), owned = fs.fstatSync(lock)
        if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(lockPath)
      } catch {}
      fs.closeSync(lock)
    }
  }
}
