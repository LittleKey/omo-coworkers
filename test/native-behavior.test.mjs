import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readBehaviorSettings, behaviorContributions, updateBehaviorSettings } from "../openchamber/service/behavior-settings.mjs"

const base = fileURLToPath(new URL("../.opencode/work/behavior-tests/", import.meta.url))
fs.mkdirSync(base, { recursive: true })
function fixture(t) {
  const home = fs.mkdtempSync(path.join(base, "home-"))
  const root = path.join(home, "config")
  const options = { home, root, env: {} }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return { home, root, options, file: path.join(root, ".omo-coworkers/behavior.json") }
}

test("default off, exact legacy compatibility, explicit settings override both flags", t => {
  const { options } = fixture(t)
  assert.equal(readBehaviorSettings(options).claudeGuardEnabled, false)
  const legacy = { ...options, env: { OMO_COWORKERS_ENABLE_CLAUDE_GUARD: "1", OMO_COWORKERS_ENABLE_WRITER_ROLE: "1" } }
  assert.equal(readBehaviorSettings(legacy).writerTransformEnabled, true)
  assert.throws(() => updateBehaviorSettings({ ...options, revision: "missing", claudeGuardEnabled: true }), { code: "CONFIRMATION_REQUIRED" })
  const saved = updateBehaviorSettings({ ...legacy, revision: "missing", claudeGuardEnabled: false })
  assert.equal(saved.claudeGuardEnabled, false)
  assert.equal(saved.writerTransformEnabled, false)
  assert.equal(saved.runtimeConfirmed, false)
  assert.equal(saved.source, "settings")
})

test("CAS, lock contention, duplicate diagnostics and safe projection", t => {
  const { options, root } = fixture(t)
  const first = updateBehaviorSettings({ ...options, revision: "missing", claudeGuardEnabled: true, confirmEnable: true })
  assert.throws(() => updateBehaviorSettings({ ...options, revision: "missing", claudeGuardEnabled: false }), { code: "CONFLICT" })
  const lock = path.join(root, ".omo-coworkers/behavior.lock")
  fs.writeFileSync(lock, "")
  assert.throws(() => updateBehaviorSettings({ ...options, revision: first.revision, claudeGuardEnabled: false }), { code: "BUSY" })
  fs.unlinkSync(lock)
  assert.ok(behaviorContributions({ ...options, standaloneClaudeAdvisorVisible: true }).diagnostics.includes("DUPLICATE_CLAUDE_ADVISOR"))
  assert.equal(behaviorContributions(options).duplicateObservation, "unknown")
})

test("invalid files fail closed without leaking input or environment fallback", t => {
  const { options, file } = fixture(t)
  updateBehaviorSettings({ ...options, revision: "missing", claudeGuardEnabled: false })
  for (const text of ['secret-not-json', '{"version":1,"claudeGuardEnabled":true,"writerTransformEnabled":true}', "x".repeat(4097)]) {
    fs.writeFileSync(file, text)
    const result = readBehaviorSettings({ ...options, env: { OMO_COWORKERS_ENABLE_CLAUDE_GUARD: "1" } })
    assert.equal(result.claudeGuardEnabled, false)
    assert.equal(result.source, "blocked")
    assert.ok(!JSON.stringify(result).includes("secret-not-json"))
  }
})

test("private HOME allows existing 0775/0664, rejects symlinks and hardlinks", t => {
  const { options, root, file, home } = fixture(t)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o775 })
  fs.writeFileSync(file, '{"version":1,"claudeGuardEnabled":false}\n', { mode: 0o664 })
  assert.equal(readBehaviorSettings(options).source, "settings")
  const mode = fs.statSync(root).mode
  updateBehaviorSettings({ ...options, revision: readBehaviorSettings(options).revision, claudeGuardEnabled: false })
  assert.equal(fs.statSync(root).mode, mode)
  const other = path.join(home, "other")
  fs.renameSync(file, other)
  fs.symlinkSync(other, file)
  assert.equal(readBehaviorSettings(options).source, "blocked")
  fs.unlinkSync(file)
  fs.linkSync(other, file)
  assert.equal(readBehaviorSettings(options).source, "blocked")
})

test("default root resolution and relocated no-dependency settings module", t => {
  const { home } = fixture(t)
  const xdgConfigHome = path.join(home, "xdg")
  const options = { home, xdgConfigHome, env: {} }
  updateBehaviorSettings({ ...options, revision: "missing", claudeGuardEnabled: true, confirmEnable: true })
  assert.equal(readBehaviorSettings(options).claudeGuardEnabled, true)
  const relocated = path.join(home, "behavior-settings.mjs")
  fs.copyFileSync(new URL("../openchamber/plugin/behavior-settings.mjs", import.meta.url), relocated)
  const script = `import {readBehaviorSettings} from ${JSON.stringify(new URL("file://" + relocated).href)}; if(!readBehaviorSettings(${JSON.stringify(options)}).claudeGuardEnabled) process.exit(2)`
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: home }, encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
})

test("relocated complete native plugin loads default-off without registering transforms", async t => {
  const { home } = fixture(t)
  const relocated = path.join(home, "payload")
  fs.mkdirSync(path.join(relocated, "openchamber"), { recursive: true })
  fs.mkdirSync(path.join(relocated, "plugins"), { recursive: true })
  fs.cpSync(new URL("../openchamber/plugin/", import.meta.url), path.join(relocated, "openchamber/plugin"), { recursive: true })
  fs.cpSync(new URL("../plugins/claude-advisor/", import.meta.url), path.join(relocated, "plugins/claude-advisor"), { recursive: true })
  fs.writeFileSync(path.join(relocated, "package.json"), '{"type":"module"}')
  const entry = new URL("file://" + path.join(relocated, "openchamber/plugin/index.mjs")).href
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const {default:p}=await import(${JSON.stringify(entry)}); await p.setup(new Proxy({}, {get(){throw Error("unexpected registration")}}));`], { env: { HOME: home }, encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
})
