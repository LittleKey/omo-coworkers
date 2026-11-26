import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"

export function behaviorPath({ home = os.homedir(), xdgConfigHome = process.env.XDG_CONFIG_HOME, root } = {}) {
  if (!path.isAbsolute(home) || (xdgConfigHome && !path.isAbsolute(xdgConfigHome)) || (root && !path.isAbsolute(root))) throw new Error("UNSAFE_PATH")
  return path.join(root || path.join(xdgConfigHome || path.join(home, ".config"), "opencode"), ".omo-coworkers", "behavior.json")
}

// Private owned ancestors protect ordinary group-writable descendants.
// Symlinks are deliberately not followed; this is not a same-UID sandbox.
export function assertBehaviorPath(target) {
  let current = path.parse(target).root
  let privateAncestor = false
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      if (error.code === "ENOENT") return
      throw new Error("UNSAFE_PATH")
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== target) || (!stat.isDirectory() && !stat.isFile())) throw new Error("UNSAFE_PATH")
    const owned = stat.uid === process.getuid?.()
    if ((!privateAncestor && (stat.mode & 0o022)) || (privateAncestor && !owned)) throw new Error("UNSAFE_PATH")
    if (owned && stat.isDirectory() && !(stat.mode & 0o077)) privateAncestor = true
    if (current === target && (!owned || (!stat.isDirectory() && stat.nlink !== 1))) throw new Error("UNSAFE_PATH")
  }
}

export function readBehaviorSettings(options = {}) {
  const result = { claudeGuardEnabled: false, writerTransformEnabled: false, revision: "missing", source: "default", diagnostics: [], runtimeConfirmed: false, reloadRequired: true }
  try {
    const target = behaviorPath(options)
    assertBehaviorPath(target)
    let bytes
    try {
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error("INVALID_SETTINGS")
        bytes = fs.readFileSync(fd)
      } finally { fs.closeSync(fd) }
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (bytes) {
      result.revision = createHash("sha256").update(bytes).digest("hex")
      result.source = "settings"
      const data = JSON.parse(bytes.toString("utf8"))
      if (!data || Array.isArray(data) || typeof data !== "object" || Object.keys(data).some(key => !["version", "claudeGuardEnabled", "writerTransformEnabled"].includes(key)) || data.version !== 1 || typeof data.claudeGuardEnabled !== "boolean" || (data.writerTransformEnabled !== undefined && data.writerTransformEnabled !== false)) throw new Error("INVALID_SETTINGS")
      result.claudeGuardEnabled = data.claudeGuardEnabled
    } else {
      const env = options.env || process.env
      result.claudeGuardEnabled = env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD === "1"
      result.writerTransformEnabled = env.OMO_COWORKERS_ENABLE_WRITER_ROLE === "1"
      if (result.claudeGuardEnabled || result.writerTransformEnabled) {
        result.source = "legacy-environment"
        result.diagnostics.push("LEGACY_ENVIRONMENT_OPT_IN")
      }
    }
  } catch {
    result.claudeGuardEnabled = false
    result.writerTransformEnabled = false
    result.source = "blocked"
    result.diagnostics.push("INVALID_OR_UNSAFE_BEHAVIOR_SETTINGS")
  }
  return result
}
