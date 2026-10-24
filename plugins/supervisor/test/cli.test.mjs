// P3 CLI + P4 patch output tests (m1-plan §4 T3 / T5 / T6 + unit coverage).
// Everything runs against a temporary --root and temporary target files;
// no test touches the production memory root.
//
// T3 — authorization/disable races: object changed between stage 2 and stage 3
//      → hash+fingerprint invalidation refuses; digest→disable→approve refused;
//      re-report/merge/draft-regen cannot revive authorization; non-TTY refused.
// T5 — target boundaries: unconfirmed path / shared project_id new dir /
//      subdir scope / CLAUDE.md-only / tracked target / >10-line body /
//      externally changed target.
// T6 — zero writes: no command path writes any file outside the store root and
//      its digest/ views; no path ever writes a target file.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawnSync } from "node:child_process"
import {
  initStore,
  openStore,
  FaultInjected,
  FILE_LOCK,
} from "../lib/memory/store.mjs"
import { main, isoWeekKey, weeklyCounts } from "../lib/memory/cli/cli.mjs"
import { parseArgs } from "../lib/memory/cli/args.mjs"
import {
  openMarker,
  closeMarker,
  buildSegment,
  findSegments,
  generatePatch,
  generateRemove,
  formatPatch,
  PatchError,
  BODY_MAX_LINES,
} from "../lib/memory/cli/patch.mjs"
import { readonlyCheck } from "../lib/memory/cli/checks.mjs"
import { candidateTargets, userGlobalAgentsPath, whyTarget } from "../lib/memory/cli/targets.mjs"
import { draftEnv, buildDraftPrompt, draftOnce } from "../lib/memory/cli/draft.mjs"
import { readDrafts, saveDraft, recordDraftFailure } from "../lib/memory/cli/views.mjs"

// ---------- fixtures ----------

/** Raw base dir: store NOT initialized; proj/ + home/ prepared. */
function makeBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "svmem-cli-"))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const proj = path.join(base, "proj")
  const home = path.join(base, "home")
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
  return { base, proj, home }
}

/** Fixture with an initialized store and an existing target AGENTS.md. */
function makeFixture(t, { targetContent = "# Project notes\n" } = {}) {
  const fx = makeBase(t)
  fx.storeRoot = path.join(fx.base, "store")
  initStore(fx.storeRoot)
  fx.target = path.join(fx.proj, "AGENTS.md")
  fs.writeFileSync(fx.target, targetContent)
  return fx
}

function seedIssue(storeRoot, { projectId = "proj-alpha", excerpt = "始终用 const, 不要用 var", title = "JS 变量声明规则", messageId } = {}) {
  const store = openStore(storeRoot)
  const r = store.appendEvent({
    source: { sessionId: "ses-test", projectId, messageId: messageId ?? `msg-${Math.random().toString(16).slice(2)}` },
    evidence: { excerpt },
    title,
    topic: "code-style",
    classification: { kind: "preference", layer: "project" },
  })
  return r.issue
}

const BODY = "在 JavaScript 中始终使用 const 声明变量\n不要使用 var"

/** Approve answer sequence: body → scope → agents → reviewDate → targets →
 *  [dirConfirm] → [trackedConfirm] → stage3. */
function approveAnswers({ body = BODY, scope = "1", dirConfirm = "y", trackedConfirm = null, stage3 = "y", targets = "1", dirInput = null } = {}) {
  const a = [body]
  a.push(scope)
  if (dirInput !== null) a.push(dirInput)
  a.push("") // agents (none)
  a.push("") // reviewDate (default)
  a.push(targets)
  if (dirConfirm !== null) a.push(dirConfirm)
  if (trackedConfirm !== null) a.push(trackedConfirm)
  a.push(stage3)
  return a
}

function fakeIO(answers = [], { isTTY = true } = {}) {
  const prints = []
  const calls = []
  let i = 0
  const take = (kind, prompt) => {
    calls.push(`${kind}:${prompt}`)
    const a = answers[i++]
    if (a === undefined) throw new Error(`fakeIO: answer #${i - 1} (${kind} "${prompt}") missing`)
    if (typeof a === "object" && a !== null) {
      if (typeof a.sideEffect === "function") a.sideEffect()
      return a.answer
    }
    return a
  }
  return {
    isTTY,
    prints,
    calls,
    print: (line = "") => { prints.push(String(line)) },
    confirm: (p) => { const v = take("confirm", p); prints.push(`? ${p} → ${v}`); return v === "y" || v === "yes" },
    choose: (p, options) => { const v = Number(take("choose", p)); prints.push(`? ${p} → ${v}/${options.length}`); return v - 1 },
    input: (p, def = "") => { const v = take("input", p); const r = v === "" ? def : v; prints.push(`? ${p}(${def}) → ${r}`); return r },
    inputLines: (p) => { const v = take("inputLines", p); prints.push(`? ${p} → ${v.split("\n").length} 行`); return v },
    close: () => {},
  }
}

/** Run main() in-process, capturing console output. */
async function runCli(argv, fx, { io, env = {}, fetchImpl, draftTimeoutMs } = {}) {
  const logs = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => logs.push(a.join(" "))
  console.error = (...a) => logs.push("STDERR: " + a.join(" "))
  try {
    const theIo = io ?? fakeIO([])
    const argv2 = fx.storeRoot ? [...argv, "--root", fx.storeRoot] : [...argv]
    const code = await main(argv2, {
      env,
      cwd: fx.proj,
      home: fx.home,
      io: theIo,
      fetchImpl,
      draftTimeoutMs,
    })
    return { code, logs, io: theIo, text: [...logs, ...theIo.prints].join("\n") }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

function snapshot(dir) {
  const out = new Map()
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, r)
      else {
        const st = fs.statSync(p, { bigint: true })
        out.set(r, `${st.size}:${st.mtimeNs}`)
      }
    }
  }
  walk(dir, "")
  return out
}

const STORE_PREFIX = /^store\//

/** Assert nothing outside <root>/ (store state + digest/ views) changed. */
function assertOnlyStoreWrites(label, fx, before) {
  const after = snapshot(fx.base)
  for (const [p, v] of after) {
    if (STORE_PREFIX.test(p)) continue
    assert.equal(before.get(p), v, `${label}: ${p} must not be written`)
  }
  for (const p of before.keys()) {
    assert.ok(after.has(p), `${label}: ${p} disappeared`)
  }
}

/** Assert literally nothing changed (refusal paths record nothing). */
function assertNothingChanged(label, fx, before) {
  const after = snapshot(fx.base)
  assert.deepEqual(
    [...after.entries()].sort(),
    [...before.entries()].sort(),
    `${label}: nothing may change on a refused path`,
  )
}

function seedRule(storeRoot, { body, target, projectId = "proj-alpha" }) {
  const store = openStore(storeRoot)
  const { rule } = store.recordDecision({
    kind: "approve",
    object: { body, scope: { kind: "project", projectId }, targets: [target], channel: "patch-human-apply" },
  })
  return rule
}

// ---------- patch.mjs (P4 segment/patch units) ----------

test("patch: marker pair format is the finalized per-rule per-version pair", () => {
  assert.equal(openMarker("RUL-abc", 2), "<!-- supervisor-memory:rule:RUL-abc:v2 -->")
  assert.equal(closeMarker("RUL-abc", 2), "<!-- /supervisor-memory:rule:RUL-abc:v2 -->")
})

test("patch: buildSegment wraps body with markers", () => {
  const seg = buildSegment("RUL-a", 1, "line one\nline two")
  assert.ok(seg.includes("<!-- supervisor-memory:rule:RUL-a:v1 -->"))
  assert.ok(seg.includes("line one"))
  assert.ok(seg.includes("<!-- /supervisor-memory:rule:RUL-a:v1 -->"))
})

test("patch: body over 10 lines is rejected whole, never truncated", () => {
  const body11 = Array.from({ length: BODY_MAX_LINES + 1 }, (_, i) => `l${i + 1}`).join("\n")
  assert.throws(() => buildSegment("RUL-a", 1, body11), (e) => {
    assert.ok(e instanceof PatchError)
    assert.match(e.message, /10/)
    return true
  })
})

test("patch: empty body rejected", () => {
  assert.throws(() => buildSegment("RUL-a", 1, "\n \n"), PatchError)
})

test("patch: findSegments fail-closed on anomalies", () => {
  const ok = buildSegment("RUL-a", 1, "b")
  // unclosed
  assert.ok(findSegments(`${ok.split("\n")[0]}\nbody\n`).errors.length > 0)
  // mismatched close (wrong version)
  assert.ok(findSegments(`${ok.split("\n")[0]}\nbody\n<!-- /supervisor-memory:rule:RUL-a:v2 -->`).errors.length > 0)
  // duplicate same version
  assert.ok(findSegments(`${ok}\n${ok}`).errors.length > 0)
  // nested
  const outer = buildSegment("RUL-outer", 1, "x")
  assert.ok(findSegments(`${outer.split("\n")[0]}\n${ok}\n<!-- /supervisor-memory:rule:RUL-outer:v1 -->`).errors.length > 0)
  // clean file parses
  const clean = findSegments(`# hi\n\n${ok}\n`)
  assert.equal(clean.errors.length, 0)
  assert.equal(clean.segments.length, 1)
  assert.equal(clean.segments[0].ruleId, "RUL-a")
})

test("patch: generatePatch add appends a managed segment", () => {
  const content = "# Project notes\n"
  const r = generatePatch(content, { ruleId: "RUL-new", version: 1, body: BODY, previous: null })
  assert.equal(r.action, "add")
  assert.match(r.anchor, /append|追加|add/i)
  assert.ok(r.block.includes(openMarker("RUL-new", 1)))
  assert.ok(r.block.includes(closeMarker("RUL-new", 1)))
})

test("patch: generatePatch replace when previous version segment matches", () => {
  const v1 = buildSegment("RUL-a", 1, BODY)
  const content = `# header\n\n${v1}\nfooter\n`
  const r = generatePatch(content, { ruleId: "RUL-a", version: 2, body: "new body", previous: { version: 1, body: BODY } })
  assert.equal(r.action, "replace")
  assert.match(r.anchor, /replace lines/)
  assert.ok(r.block.includes(openMarker("RUL-a", 2)))
  assert.equal(r.removed, BODY) // removed = old body lines (markers excluded)
})

test("patch: previous body mismatch → target changed → human review", () => {
  const v1 = buildSegment("RUL-a", 1, "内容被人改过")
  const content = `${v1}\n`
  assert.throws(
    () => generatePatch(content, { ruleId: "RUL-a", version: 2, body: "new body", previous: { version: 1, body: BODY } }),
    /target changed/,
  )
})

test("patch: no previous but segment already present → refuse", () => {
  const v1 = buildSegment("RUL-a", 1, BODY)
  assert.throws(
    () => generatePatch(`${v1}\n`, { ruleId: "RUL-a", version: 1, body: BODY, previous: null }),
    PatchError,
  )
})

test("patch: other version present → refuse (send for human review)", () => {
  const v9 = buildSegment("RUL-a", 9, BODY)
  assert.throws(
    () => generatePatch(`${v9}\n`, { ruleId: "RUL-a", version: 1, body: BODY, previous: null }),
    /target changed/,
  )
})

test("patch: marker anomaly → refuse (fail-closed)", () => {
  assert.throws(
    () => generatePatch("<!-- supervisor-memory:rule:RUL-x:v1 -->\nunclosed\n", { ruleId: "RUL-y", version: 1, body: BODY, previous: null }),
    PatchError,
  )
})

test("patch: generateRemove finds managed segment / null when absent", () => {
  const v1 = buildSegment("RUL-a", 1, BODY)
  const content = `# h\n\n${v1}\n# t\n`
  const patches = generateRemove(content, { ruleId: "RUL-a" })
  assert.ok(Array.isArray(patches) && patches.length === 1)
  assert.equal(patches[0].action, "remove")
  assert.match(patches[0].anchor, /delete lines/)
  assert.equal(generateRemove("# nothing here\n", { ruleId: "RUL-a" }), null)
  assert.throws(() => generateRemove("<!-- supervisor-memory:rule:RUL-z:v1 -->\n", { ruleId: "RUL-z" }), PatchError)
})

test("patch: formatPatch carries the boundary explanation", () => {
  const text = formatPatch({
    targetPath: "/x/AGENTS.md",
    why: whyTarget({ kind: "project" }),
    scopePromise: "project — 项目 proj-alpha 根 AGENTS.md",
    tracked: "git 未跟踪",
    patch: { action: "add", anchor: "append after line 1", block: buildSegment("RUL-a", 1, BODY), notes: [] },
  })
  assert.ok(text.includes("/x/AGENTS.md"))
  assert.ok(text.includes("why this target"))
  assert.ok(text.includes("scope promise"))
  assert.ok(text.includes("tracking"))
  assert.ok(text.includes("supervisor-memory:rule:RUL-a:v1"))
})

// ---------- args.mjs ----------

test("args: value flags, booleans, --f=v and -- terminator", () => {
  const { flags, pos } = parseArgs(["--root", "/a", "--draft", "approve", "--store-draft", "x", "--spent-min=12", "--", "--not-flag"])
  assert.equal(flags.root, "/a")
  assert.equal(flags.draft, true)
  assert.equal(flags["store-draft"], true)
  assert.equal(flags["spent-min"], "12")
  assert.deepEqual(pos, ["approve", "x", "--not-flag"])
})

// ---------- targets.mjs ----------

test("targets: project candidates — confirmed dirs, unconfirmed, unregistered cwd", (t) => {
  const fx = makeBase(t)
  const dirA = path.join(fx.proj, "a")
  const dirB = path.join(fx.proj, "b")
  for (const d of [dirA, dirB]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, "AGENTS.md"), "# x\n")
  }
  fs.writeFileSync(path.join(fx.proj, "AGENTS.md"), "# cwd\n")
  const storeRoot = path.join(fx.base, "store")
  initStore(storeRoot)
  const store = openStore(storeRoot)
  store.upsertProject({ projectId: "p1", directory: dirA, confirmDirectory: true })
  store.upsertProject({ projectId: "p1", directory: dirB })
  const projects = store.listProjects()
  const cands = candidateTargets({ scope: { kind: "project", projectId: "p1" }, projects, cwd: fx.proj, home: fx.home })
  // dirA confirmed, dirB unconfirmed, cwd unregistered — cwd comes last
  assert.equal(cands.length, 3)
  assert.equal(cands[0].directory, dirA)
  assert.equal(cands[0].confirmedDir, true)
  assert.equal(cands[1].confirmedDir, false)
  assert.match(cands[1].notes.join(" "), /directory unconfirmed/)
  assert.equal(cands[2].directory, fx.proj)
  assert.match(cands[2].notes.join(" "), /registers and confirms/)
  for (const c of cands) assert.equal(c.exists, true)
})

test("targets: user-global path and directory scope, never creates files", (t) => {
  assert.equal(userGlobalAgentsPath("/h"), path.join("/h", ".config", "opencode", "AGENTS.md"))
  const fx = makeBase(t)
  const cands = candidateTargets({ scope: { kind: "user-global" }, projects: [], cwd: fx.proj, home: fx.home })
  assert.equal(cands.length, 1)
  assert.equal(cands[0].path, userGlobalAgentsPath(fx.home))
  assert.equal(cands[0].exists, false) // home AGENTS.md not created here
})

// ---------- checks.mjs (D9 readonly, three states kept separate) ----------

test("checks: awaiting-apply observed present → note, no drift, no residue", (t) => {
  const fx = makeBase(t)
  const target = path.join(fx.proj, "AGENTS.md")
  const storeRoot = path.join(fx.base, "store")
  initStore(storeRoot)
  const rule = seedRule(storeRoot, { body: BODY, target })
  fs.writeFileSync(target, `# x\n${buildSegment(rule.id, 1, BODY)}\n`)
  const store = openStore(storeRoot)
  const { rows } = readonlyCheck(store.listRules(), store.listDecisions())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, "awaiting-apply")
  assert.equal(rows[0].observed, "present")
  assert.match(rows[0].note, /manually applied/)
  assert.equal(rows[0].drift, null)
})

test("checks: applied but segment absent → drift reported, reviewNeeded", (t) => {
  const fx = makeBase(t)
  const target = path.join(fx.proj, "AGENTS.md")
  fs.writeFileSync(target, "# untouched\n")
  const storeRoot = path.join(fx.base, "store")
  initStore(storeRoot)
  const rule = seedRule(storeRoot, { body: BODY, target })
  openStore(storeRoot).recordPublishResult(rule.id, { applied: true, note: "t" })
  const store = openStore(storeRoot)
  const { rows, reviewNeeded } = readonlyCheck(store.listRules(), store.listDecisions())
  assert.equal(rows[0].state, "approved")
  assert.equal(rows[0].expected, "present")
  assert.equal(rows[0].observed, "absent")
  assert.equal(rows[0].drift, "absent")
  assert.equal(reviewNeeded.length, 1) // applied ≠ target state → human review
})

test("checks: disabled residue and old-version residue reported", (t) => {
  const fx = makeBase(t)
  const target = path.join(fx.proj, "AGENTS.md")
  fs.writeFileSync(target, `# x\n${buildSegment("RUL-a", 1, BODY)}\n`)
  const storeRoot = path.join(fx.base, "store")
  initStore(storeRoot)
  const rule = seedRule(storeRoot, { body: BODY, target })
  fs.writeFileSync(target, `# x\n${buildSegment(rule.id, 1, BODY)}\n`)
  const store1 = openStore(storeRoot)
  store1.recordPublishResult(rule.id, { applied: true, note: "t" })
  store1.recordDecision({ kind: "approve", ruleId: rule.id, object: { body: "新版本正文", scope: { kind: "project", projectId: "proj-alpha" }, targets: [target], channel: "patch-human-apply" } })
  store1.recordDecision({ kind: "disable", ruleId: rule.id })
  const store = openStore(storeRoot)
  const { rows } = readonlyCheck(store.listRules(), store.listDecisions())
  const states = rows.map((r) => r.state)
  assert.ok(states.includes("readonly-disabled"))
  assert.ok(states.includes("readonly-old-version"))
  // v1 segment still physically present → residue on the old-version record
  const old = rows.find((r) => r.state === "readonly-old-version")
  assert.equal(old.version, null)
  assert.equal(old.observed, "present")
  assert.ok(old.residue)
})

// ---------- views.mjs ----------

test("views: draft roundtrip, 0600 mode; failure count + capped history", (t) => {
  const fx = makeBase(t)
  const root = path.join(fx.base, "store")
  initStore(root)
  saveDraft(root, "ISS-1", "草稿正文", 123)
  const d = readDrafts(root)
  assert.equal(d.drafts["ISS-1"].body, "草稿正文")
  const st = fs.statSync(path.join(root, "digest", "drafts.json"))
  assert.equal(st.mode & 0o777, 0o600)
  for (let i = 0; i < 25; i++) recordDraftFailure(root, "ISS-1", `原因${i}`, 456 + i)
  const f = readDrafts(root).failures["ISS-1"]
  assert.equal(f.count, 25)
  assert.ok(f.history.length <= 20)
})

// ---------- draft.mjs (one attempt, scoped envelope) ----------

test("draft: env defaults and overrides", () => {
  const d = draftEnv({})
  assert.equal(d.apiKey, null)
  assert.equal(d.baseUrl, "http://10.126.126.10:3000/v1")
  assert.equal(d.model, "glm-5.3")
  const o = draftEnv({ SUPERVISOR_MEMORY_DRAFT_API_KEY: "k", SUPERVISOR_MEMORY_DRAFT_BASE_URL: "http://x/1/", SUPERVISOR_MEMORY_DRAFT_MODEL: "m1" })
  assert.equal(o.apiKey, "k")
  assert.equal(o.baseUrl, "http://x/1")
  assert.equal(o.model, "m1")
})

test("draft: prompt carries only this candidate's events + excerpts", () => {
  const issue = { id: "ISS-1", title: "T", topic: "tp", classification: { kind: "preference" } }
  const events = [{ id: "EVT-1", evidence: { excerpt: "SECRET-EXCERPT" } }]
  const msgs = buildDraftPrompt(issue, events)
  assert.equal(msgs.length, 2)
  assert.match(msgs[0].content, /at most 10 lines/)
  assert.ok(msgs[0].content.includes("marker"))
  assert.ok(msgs[1].content.includes("SECRET-EXCERPT"))
  assert.ok(msgs[1].content.includes("ISS-1") || msgs[1].content.includes("T"))
})

test("draft: no key → skipped, fetch never called", async () => {
  let called = 0
  const r = await draftOnce({ issue: {}, events: [], env: { apiKey: null }, fetchImpl: () => { called++; return Promise.resolve({ ok: true, json: async () => ({}) }) } })
  assert.equal(r.status, "no-key")
  assert.equal(called, 0)
})

test("draft: success parses content, Bearer auth, correct URL/body", async () => {
  let seen = null
  const fetchImpl = async (url, opts) => {
    seen = { url, opts }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "草稿正文ABC" } }] }) }
  }
  const r = await draftOnce({ issue: { id: "ISS-1", title: "T" }, events: [{ id: "EVT-1", evidence: { excerpt: "摘录内容" } }], env: { apiKey: "k1", baseUrl: "http://host/v1", model: "glm-5.3" }, fetchImpl })
  assert.equal(r.status, "ok")
  assert.equal(r.text, "草稿正文ABC")
  assert.equal(seen.url, "http://host/v1/chat/completions")
  assert.equal(seen.opts.headers.authorization, "Bearer k1")
  const body = JSON.parse(seen.opts.body)
  assert.equal(body.model, "glm-5.3")
  assert.ok(body.messages[1].content.includes("摘录内容"))
})

test("draft: HTTP failure → failed, single attempt", async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: false, status: 500 } }
  const r = await draftOnce({ issue: {}, events: [], env: { apiKey: "k", baseUrl: "http://h", model: "m" }, fetchImpl })
  assert.equal(r.status, "failed")
  assert.match(r.error, /500/)
  assert.equal(calls, 1)
})

test("draft: timeout aborts, fetch called exactly once", async () => {
  let calls = 0
  const fetchImpl = (url, opts) => {
    calls++
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("AbortError")))
    })
  }
  const r = await draftOnce({ issue: {}, events: [], env: { apiKey: "k", baseUrl: "http://h", model: "m" }, fetchImpl, timeoutMs: 30 })
  assert.equal(r.status, "timeout")
  assert.equal(calls, 1)
})

// ---------- weekly (D10) ----------

test("weekly: isoWeekKey ISO-8601 incl. year boundary", () => {
  assert.equal(isoWeekKey(new Date(2026, 0, 1).getTime()), "2026-W01") // Thursday
  assert.equal(isoWeekKey(new Date(2026, 9, 23).getTime()), "2026-W43") // Friday
  assert.equal(isoWeekKey(new Date(2023, 0, 1).getTime()), "2022-W52") // Sunday
})

test("weekly: weeklyCounts candidates/approved/dropped/recurrences", (t) => {
  const fx = makeBase(t)
  const storeRoot = path.join(fx.base, "store")
  initStore(storeRoot)
  const store = openStore(storeRoot)
  const issA = seedIssue(storeRoot, { projectId: "p", messageId: "m-a" })
  seedIssue(storeRoot, { projectId: "p", messageId: "m-b", title: "B" })
  store.recordDecision({ kind: "approve", object: { body: "b", scope: { kind: "user-global" }, targets: [], channel: "patch-human-apply" } })
  store.upsertIssue({ id: issA.id, status: "dropped" })
  // surgery: make issA older than the current week → its counts as recurrence
  const issuesPath = path.join(storeRoot, "issues.json")
  const doc = JSON.parse(fs.readFileSync(issuesPath, "utf8"))
  doc.issues[issA.id].createdAtTs = Date.now() - 30 * 86_400_000
  fs.writeFileSync(issuesPath, JSON.stringify(doc))
  const store2 = openStore(storeRoot)
  const weekStart = isoWeekMondayOfNow()
  const counts = weeklyCounts(store2, weekStart)
  assert.equal(counts.candidates, 1) // issA was moved out of the week by surgery
  assert.equal(counts.approved, 1)
  assert.equal(counts.dropped, 1)
  assert.equal(counts.recurrences, 1) // event this week on an issue created before the week
})

function isoWeekMondayOfNow() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

// ---------- CLI: basics ----------

test("cli: help exits 0 and lists all eight subcommands", async (t) => {
  const fx = makeBase(t)
  const r = await runCli(["help"], fx)
  assert.equal(r.code, 0)
  for (const cmd of ["init", "digest", "approve", "discard", "merge", "disable", "status", "doctor"]) {
    assert.ok(r.text.includes(cmd), `usage mentions ${cmd}`)
  }
})

test("cli: unknown subcommand exits 2", async (t) => {
  const fx = makeFixture(t)
  const r = await runCli(["bogus"], fx)
  assert.equal(r.code, 2)
})

test("cli: init creates store; second init refuses to overwrite", async (t) => {
  const fx = makeBase(t)
  fx.storeRoot = path.join(fx.base, "store")
  const r1 = await runCli(["init"], fx)
  assert.equal(r1.code, 0)
  assert.ok(fs.existsSync(path.join(fx.storeRoot, "rules.json")))
  assert.ok(fs.existsSync(path.join(fx.storeRoot, "commit.marker")))
  const r2 = await runCli(["init"], fx)
  assert.equal(r2.code, 1)
  assert.match(r2.text, /never overwritten/)
})

test("cli: schema gate refuses mismatched version with upgrade path", async (t) => {
  const fx = makeFixture(t)
  const rulesPath = path.join(fx.storeRoot, "rules.json")
  const doc = JSON.parse(fs.readFileSync(rulesPath, "utf8"))
  doc.version = 99
  fs.writeFileSync(rulesPath, JSON.stringify(doc))
  const r = await runCli(["status"], fx)
  assert.equal(r.code, 1)
  assert.match(r.text, /STORE_SCHEMA/)
  assert.match(r.text, /Upgrade path/)
  assert.match(r.text, /back up/)
})

test("cli: status ok on fresh store; corrupt refused fail-closed", async (t) => {
  const fx = makeFixture(t)
  const ok = await runCli(["status"], fx)
  assert.equal(ok.code, 0)
  assert.match(ok.text, /health: ok/)
  fs.appendFileSync(path.join(fx.storeRoot, "events.jsonl"), "THIS IS NOT JSON\n")
  const bad = await runCli(["status"], fx)
  assert.equal(bad.code, 1)
  assert.match(bad.text, /STORE_CORRUPT/)
})

test("cli: digest prints pending candidates with source excerpts and writes views", async (t) => {
  const fx = makeFixture(t)
  seedIssue(fx.storeRoot, { excerpt: "独特的摘录字符串XYZ" })
  seedIssue(fx.storeRoot, { projectId: "proj-beta", title: "另一个候选" })
  const r = await runCli(["digest"], fx)
  assert.equal(r.code, 0)
  assert.match(r.text, /pending review: 2 candidates/)
  assert.match(r.text, /独特的摘录字符串XYZ/)
  assert.match(r.text, /另一个候选/)
  assert.match(r.text, /session=ses-test/)
  for (const f of ["pending.json", "checks.json", "weekly.json"]) {
    assert.ok(fs.existsSync(path.join(fx.storeRoot, "digest", f)), `view ${f} written`)
  }
})

test("cli: digest renders three readonly states, drift, residue, human review", async (t) => {
  const fx = makeFixture(t)
  const store = openStore(fx.storeRoot)
  // RUL-a applied and present → approved + 在场
  const a = seedRule(fx.storeRoot, { body: BODY, target: fx.target })
  fs.appendFileSync(fx.target, `\n${buildSegment(a.id, 1, BODY)}\n`)
  store.recordPublishResult(a.id, { applied: true, note: "t" })
  // RUL-b applied but segment never written → drift + 送人审
  const b = seedRule(fx.storeRoot, { body: "规则乙的正文", target: fx.target })
  store.recordPublishResult(b.id, { applied: true, note: "t" })
  // RUL-c disabled while segment still present → 残留
  const c = seedRule(fx.storeRoot, { body: "规则丙的正文", target: fx.target })
  fs.appendFileSync(fx.target, `\n${buildSegment(c.id, 1, "规则丙的正文")}\n`)
  store.recordDecision({ kind: "disable", ruleId: c.id })
  const r = await runCli(["digest"], fx)
  assert.equal(r.code, 0)
  assert.match(r.text, /approved \(should be present\)/)
  assert.match(r.text, /present/)
  assert.match(r.text, /disabled \(should be absent\)/)
  assert.match(r.text, /residue/)
  assert.match(r.text, /drift/)
  assert.match(r.text, /report only, never rewrite/)
  assert.match(r.text, /send for human review \(never inferred as user deletion\)/)
})

test("cli: discard issue → dropped (refused again); discard event → false_positive", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot, { messageId: "m-1" })
  const r1 = await runCli(["discard", iss.id], fx)
  assert.equal(r1.code, 0)
  assert.match(r1.text, /discarded/)
  const r2 = await runCli(["discard", iss.id], fx)
  assert.equal(r2.code, 1)
  assert.match(r2.text, /terminal/)
  const store = openStore(fx.storeRoot)
  const { event } = store.appendEvent({ source: { sessionId: "s", projectId: "p", messageId: "m-2" }, evidence: { excerpt: "e" }, title: "t2", topic: "tp", classification: { kind: "capability", layer: "global" } })
  const r3 = await runCli(["discard", event.id], fx)
  assert.equal(r3.code, 0)
  assert.match(r3.text, /false positive/)
  assert.equal(openStore(fx.storeRoot).getIssue(iss.id).status, "dropped")
})

test("cli: merge keeps both sources; donor cannot be merged twice", async (t) => {
  const fx = makeFixture(t)
  const a = seedIssue(fx.storeRoot, { messageId: "m-a" })
  const b = seedIssue(fx.storeRoot, { messageId: "m-b", title: "target" })
  const r1 = await runCli(["merge", a.id, b.id], fx)
  assert.equal(r1.code, 0)
  assert.match(r1.text, /original event sources are preserved/)
  const r2 = await runCli(["merge", a.id, b.id], fx)
  assert.equal(r2.code, 1)
  const store = openStore(fx.storeRoot)
  assert.equal(store.getIssue(a.id).status, "merged")
  assert.equal(store.getIssue(a.id).mergedInto, b.id)
  // both events preserved with original sources
  const evA = store.listEvents({ issueId: a.id })
  const evB = store.listEvents({ issueId: b.id })
  assert.equal(evA.length, 1)
  assert.equal(evB.length, 1)
})

test("cli: doctor ok on fresh store; incomplete store → exit 1, authorization stays closed", async (t) => {
  const fx = makeFixture(t)
  const ok = await runCli(["doctor"], fx)
  assert.equal(ok.code, 0)
  assert.match(ok.text, /healthy/)
  makeIncompleteFixture(t, fx)
  const bad = await runCli(["doctor"], fx)
  assert.equal(bad.code, 1)
  assert.match(bad.text, /unhealthy/)
  assert.match(bad.text, /authorization output stays disabled/)
})

/** Crash mid-transaction (T4 hook) then remove the leaked lock → incomplete_commit. */
function makeIncompleteFixture(t, fx) {
  const store = openStore(fx.storeRoot, { _fault: { crashAfter: "issues:replace" } })
  assert.throws(
    () => store.appendEvent({ source: { sessionId: "s", projectId: "p", messageId: "m-crash" }, evidence: { excerpt: "x" }, title: "t", topic: "tp", classification: { kind: "preference", layer: "project" } }),
    (e) => e instanceof FaultInjected || e.name === "FaultInjected",
  )
  fs.rmSync(path.join(fx.storeRoot, FILE_LOCK), { force: true })
}

test("incomplete: digest shows diff but writes no views; approve refused (D5)", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot, { messageId: "m-1" })
  makeIncompleteFixture(t, fx)
  const d = await runCli(["digest"], fx)
  assert.equal(d.code, 0)
  assert.match(d.text, /authorization disabled/)
  assert.match(d.text, /landed/)
  assert.ok(!fs.existsSync(path.join(fx.storeRoot, "digest", "weekly.json")), "no views on incomplete store")
  const io = fakeIO(approveAnswers({}))
  const a = await runCli(["approve", iss.id], fx, { io })
  assert.equal(a.code, 1)
  assert.match(a.text, /STORE_INCOMPLETE/)
  assert.equal(openStore(fx.storeRoot).listDecisions().length, 0)
})

// ---------- approve happy paths ----------

test("approve: happy path — decision recorded, patch printed, target untouched, dir confirmed", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const beforeTarget = fs.readFileSync(fx.target, "utf8")
  const before = snapshot(fx.base)
  const io = fakeIO(approveAnswers({}))
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 0)
  assert.match(r.text, /approval object \(stage 2\/3\)/)
  assert.match(r.text, /patch-human-apply/)
  assert.match(r.text, /supervisor-memory:rule:RUL-/)
  assert.match(r.text, /\/supervisor-memory:rule:RUL-/)
  assert.match(r.text, /approval success ≠ landed/)
  const store = openStore(fx.storeRoot)
  const decisions = store.listDecisions()
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, "approve")
  assert.ok(decisions[0].objectHash.length === 64)
  const rules = store.listRules()
  assert.equal(rules.length, 1)
  assert.equal(rules[0].version, 1)
  assert.equal(rules[0].status, "active")
  assert.equal(rules[0].body, BODY)
  assert.equal(store.getIssue(iss.id).status, "approved")
  const projects = store.listProjects()
  assert.equal(projects.length, 1)
  assert.equal(projects[0].directories[0].path, fx.proj)
  assert.equal(projects[0].directories[0].confirmed, true)
  assert.equal(fs.readFileSync(fx.target, "utf8"), beforeTarget, "target file zero-write")
  assertOnlyStoreWrites("approve happy", fx, before)
})

test("approve: adopts stored draft body when confirmed", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  saveDraft(fx.storeRoot, iss.id, BODY, Date.now())
  const io = fakeIO(["y", "1", "", "", "1", "y", "y"]) // adopt draft → scope → agents → date → targets → dirConfirm → stage3
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 0)
  assert.equal(openStore(fx.storeRoot).listRules()[0].body, BODY)
})

test("approve: directory scope publishes only to that directory's file", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const io = fakeIO(approveAnswers({ scope: "3", dirInput: fx.proj }))
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 0)
  const dec = openStore(fx.storeRoot).listDecisions()[0]
  assert.equal(dec.object.scope.kind, "directory")
  assert.equal(dec.object.scope.directory, fx.proj)
})

test("approve: user-global scope targets the global AGENTS.md", async (t) => {
  const fx = makeFixture(t)
  const globalAgents = path.join(fx.home, ".config", "opencode", "AGENTS.md")
  fs.writeFileSync(globalAgents, "# global\n")
  const iss = seedIssue(fx.storeRoot)
  const io = fakeIO(approveAnswers({ scope: "2" }))
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 0)
  const dec = openStore(fx.storeRoot).listDecisions()[0]
  assert.equal(dec.object.scope.kind, "user-global")
  assert.deepEqual(dec.object.targets, [globalAgents])
})

// ---------- T3: authorization races ----------

test("T3: store changed between stage 2 and stage 3 → confirmation invalidated, nothing recorded", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot, { messageId: "m-race" })
  const answers = approveAnswers({})
  answers[answers.length - 1] = {
    answer: "y",
    sideEffect: () => {
      // concurrent writer lands between stage 2 display and stage 3 confirm
      openStore(fx.storeRoot).appendEvent({
        issueId: iss.id,
        source: { sessionId: "ses-other", projectId: "proj-alpha", messageId: "m-concurrent" },
        evidence: { excerpt: "并发事件" },
        title: "JS 变量声明规则",
        topic: "code-style",
        classification: { kind: "preference", layer: "project" },
      })
    },
  }
  const io = fakeIO(answers)
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /confirmation invalidated/)
  assert.match(r.text, /silent retries are forbidden/)
  const store = openStore(fx.storeRoot)
  assert.equal(store.listDecisions().length, 0)
  assert.equal(store.getIssue(iss.id).status, "draft")
})

test("T3: digest → disable → approve refused; disabled rule never revives via approve", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const a = await runCli(["approve", iss.id], fx, { io: fakeIO(approveAnswers({})) })
  assert.equal(a.code, 0)
  const ruleId = openStore(fx.storeRoot).listRules()[0].id
  const d = await runCli(["disable", ruleId], fx)
  assert.equal(d.code, 0)
  const decisionsAfterDisable = openStore(fx.storeRoot).listDecisions().length
  const r = await runCli(["approve", ruleId], fx, { io: fakeIO(approveAnswers({})) })
  assert.equal(r.code, 1)
  assert.match(r.text, /disabled/)
  assert.match(r.text, /enable/)
  assert.equal(openStore(fx.storeRoot).listDecisions().length, decisionsAfterDisable, "no new decision after disable")
})

test("T3: merge into approved / draft regen / re-report cannot revive authorization", async (t) => {
  const fx = makeFixture(t)
  const donor = seedIssue(fx.storeRoot, { messageId: "m-donor", title: "donor" })
  const target = seedIssue(fx.storeRoot, { messageId: "m-target", title: "target" })
  const m = await runCli(["merge", donor.id, target.id], fx)
  assert.equal(m.code, 0)
  const a = await runCli(["approve", target.id], fx, { io: fakeIO(approveAnswers({})) })
  assert.equal(a.code, 0)
  const decisionsAfter = openStore(fx.storeRoot).listDecisions().length
  // approve the merged donor → refused
  const r1 = await runCli(["approve", donor.id], fx, { io: fakeIO(approveAnswers({})) })
  assert.equal(r1.code, 1)
  assert.match(r1.text, /merged into/)
  // draft regeneration on an approved candidate → refused
  const r2 = await runCli(["digest", "--draft", target.id], fx, { env: { SUPERVISOR_MEMORY_DRAFT_API_KEY: "k" }, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) }) })
  assert.equal(r2.code, 1)
  assert.match(r2.text, /only draft candidates/)
  // re-reporting the same fact → duplicate, no new authorization surface
  const store = openStore(fx.storeRoot)
  const dup = store.appendEvent({ source: { sessionId: "ses-test", projectId: "proj-alpha", messageId: "m-target" }, evidence: { excerpt: "重复上报" }, title: "target", topic: "code-style", classification: { kind: "preference", layer: "project" } })
  assert.equal(dup.duplicate, true)
  assert.equal(store.listDecisions().length, decisionsAfter)
})

test("T3: non-TTY approve refused outright", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const io = fakeIO(approveAnswers({}), { isTTY: false })
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /TTY/)
  assert.equal(openStore(fx.storeRoot).listDecisions().length, 0)
})

// ---------- T5: target boundaries ----------

test("T5: unconfirmed directory declined → no decision, no project registration", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const before = snapshot(fx.base)
  const io = fakeIO(approveAnswers({ dirConfirm: "n" }))
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /no decision recorded/)
  const store = openStore(fx.storeRoot)
  assert.equal(store.listDecisions().length, 0)
  assert.equal(store.listProjects().length, 0)
  assertNothingChanged("T5 unconfirmed declined", fx, before)
})

test("T5: shared project_id, new unregistered dir requires its own confirmation", async (t) => {
  const fx = makeFixture(t)
  const dirA = path.join(fx.proj, "a")
  fs.mkdirSync(dirA, { recursive: true })
  fs.writeFileSync(path.join(dirA, "AGENTS.md"), "# a\n")
  openStore(fx.storeRoot).upsertProject({ projectId: "proj-alpha", directory: dirA, confirmDirectory: true })
  // cwd (fx.proj) hosts the session but is NOT registered — must be confirmed on its own
  const iss = seedIssue(fx.storeRoot)
  const io = fakeIO(approveAnswers({ dirConfirm: "y" }))
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 0)
  const projects = openStore(fx.storeRoot).listProjects()[0]
  assert.equal(projects.directories.length, 2)
  const cwdEntry = projects.directories.find((d) => d.path === fx.proj)
  assert.equal(cwdEntry.confirmed, true)
})

test("T5: subdir scope without an existing AGENTS.md → not published, nothing created", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const sub = path.join(fx.proj, "sub")
  fs.mkdirSync(sub, { recursive: true })
  const before = snapshot(fx.base)
  const io = fakeIO(approveAnswers({ scope: "3", dirInput: sub }))
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /no eligible target/)
  assert.ok(!fs.existsSync(path.join(sub, "AGENTS.md")), "never creates new files")
  assertNothingChanged("T5 subdir scope", fx, before)
})

test("T5: CLAUDE.md-only project → no compliant target, CLAUDE.md untouched", async (t) => {
  const fx = makeBase(t)
  fx.storeRoot = path.join(fx.base, "store")
  initStore(fx.storeRoot)
  fs.writeFileSync(path.join(fx.proj, "CLAUDE.md"), "# claude only\n")
  openStore(fx.storeRoot).upsertProject({ projectId: "proj-alpha", directory: fx.proj, confirmDirectory: true })
  const iss = seedIssue(fx.storeRoot)
  const before = snapshot(fx.base)
  const io = fakeIO([BODY, "1", "", ""]) // body, scope, agents, reviewDate — no targets offered
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /no eligible target/)
  assert.ok(!fs.existsSync(path.join(fx.proj, "AGENTS.md")))
  assertNothingChanged("T5 claude-only", fx, before)
})

test("T5: git-tracked target requires explicit confirmation (declined → nothing recorded)", async (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) { t.skip("git not available"); return }
  const fx = makeFixture(t)
  const git = (...args) => spawnSync("git", ["-C", fx.proj, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" })
  assert.equal(git("init", "-q").status, 0)
  assert.equal(git("add", "AGENTS.md").status, 0)
  assert.equal(git("commit", "-qm", "init").status, 0)
  const iss = seedIssue(fx.storeRoot)
  const before = snapshot(fx.base)
  const io = fakeIO(approveAnswers({ trackedConfirm: "n" }))
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /is git-tracked/)
  assert.match(r.text, /no decision recorded/)
  assert.equal(openStore(fx.storeRoot).listDecisions().length, 0)
  assertNothingChanged("T5 tracked declined", fx, before)
})

test("T5: body over 10 lines refused before any target or decision", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const before = snapshot(fx.base)
  const longBody = Array.from({ length: 11 }, (_, i) => `第${i + 1}行`).join("\n")
  const io = fakeIO([longBody])
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /over the 10-line limit/)
  assertNothingChanged("T5 oversize body", fx, before)
})

test("T5: externally changed target → approve refused, sent for human review", async (t) => {
  const fx = makeFixture(t)
  const rule = seedRule(fx.storeRoot, { body: BODY, target: fx.target })
  // segment exists but its content drifted from the recorded body
  fs.writeFileSync(fx.target, `${buildSegment(rule.id, 1, "这段内容已被外部改动")}\n`)
  const decisionsBefore = openStore(fx.storeRoot).listDecisions().length
  // re-approve the rule: adopt current body → stage 1/3 confirmations
  const io = fakeIO(["y", "1", "", "", "1", "y", "y"])
  const r = await runCli(["approve", rule.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /patch generation failed/)
  assert.match(r.text, /target changed/)
  assert.equal(openStore(fx.storeRoot).listDecisions().length, decisionsBefore)
})

test("T5: marker-anomaly target → approve refused fail-closed", async (t) => {
  const fx = makeFixture(t)
  fs.writeFileSync(fx.target, "<!-- supervisor-memory:rule:RUL-x:v1 -->\n未闭合\n")
  const iss = seedIssue(fx.storeRoot)
  const before = snapshot(fx.base)
  const io = fakeIO(approveAnswers({}))
  const r = await runCli(["approve", iss.id], fx, { io })
  assert.equal(r.code, 1)
  assert.match(r.text, /patch generation failed/)
  assert.equal(openStore(fx.storeRoot).listDecisions().length, 0)
  assertNothingChanged("T5 marker anomaly", fx, before)
})

// ---------- disable ----------

test("disable: records decision, prints removal patch + residue banner; re-disable refused", async (t) => {
  const fx = makeFixture(t)
  const rule = seedRule(fx.storeRoot, { body: BODY, target: fx.target })
  fs.writeFileSync(fx.target, `# x\n${buildSegment(rule.id, 1, BODY)}\n`)
  const before = snapshot(fx.base)
  const r = await runCli(["disable", rule.id], fx)
  assert.equal(r.code, 0)
  assert.match(r.text, /disabled-in-store ≠ residue withdrawn/)
  assert.match(r.text, new RegExp(openMarker(rule.id, 1)))
  assert.match(r.text, /delete lines/)
  const store = openStore(fx.storeRoot)
  assert.ok(store.listDecisions().some((d) => d.kind === "disable" && d.ruleId === rule.id))
  assert.equal(store.getRule(rule.id).status, "disabled")
  assert.equal(fs.readFileSync(fx.target, "utf8"), `# x\n${buildSegment(rule.id, 1, BODY)}\n`, "disable never rewrites the target")
  assertOnlyStoreWrites("disable", fx, before)
  const r2 = await runCli(["disable", rule.id], fx)
  assert.equal(r2.code, 1)
  assert.match(r2.text, /only active rules/)
})

test("disable: unknown rule and never-published rule behave explicitly", async (t) => {
  const fx = makeFixture(t)
  const r1 = await runCli(["disable", "RUL-none"], fx)
  assert.equal(r1.code, 1)
  assert.match(r1.text, /not found/)
  const rule = seedRule(fx.storeRoot, { body: BODY, target: fx.target })
  const r2 = await runCli(["disable", rule.id], fx)
  assert.equal(r2.code, 0)
  assert.match(r2.text, /no registered targets|no managed segment/)
})

// ---------- digest --draft (CLI level, mock endpoint / no network) ----------

test("draft cli: success → saved via TTY confirm; request carries only this candidate", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot, { excerpt: "本候选的摘录AAA" })
  seedIssue(fx.storeRoot, { projectId: "proj-beta", excerpt: "别的候选摘录BBB", messageId: "m-other" })
  let seenAuth = null
  let seenPath = null
  let seenBody = null
  const server = http.createServer((req, res) => {
    seenPath = req.url
    seenAuth = req.headers.authorization
    let raw = ""
    req.on("data", (c) => { raw += c })
    req.on("end", () => {
      seenBody = raw
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ choices: [{ message: { content: "由模型起草的正文" } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  const port = server.address().port
  const io = fakeIO(["y"])
  const r = await runCli(["digest", "--draft", iss.id], fx, {
    env: { SUPERVISOR_MEMORY_DRAFT_API_KEY: "test-key-1", SUPERVISOR_MEMORY_DRAFT_BASE_URL: `http://127.0.0.1:${port}/v1` },
    io,
  })
  assert.equal(r.code, 0)
  assert.equal(seenPath, "/v1/chat/completions")
  assert.equal(seenAuth, "Bearer test-key-1")
  const body = JSON.parse(seenBody)
  assert.equal(body.model, "glm-5.3")
  assert.ok(body.messages[1].content.includes("本候选的摘录AAA"))
  assert.ok(!body.messages[1].content.includes("别的候选摘录BBB"), "never sends other candidates")
  const drafts = readDrafts(fx.storeRoot)
  assert.equal(drafts.drafts[iss.id].body, "由模型起草的正文")
  assert.match(r.text, /drafts\.json/)
})

test("draft cli: no key → skip, exit 0, no request", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  let called = 0
  const r = await runCli(["digest", "--draft", iss.id], fx, { fetchImpl: () => { called++; return Promise.resolve({ ok: true, json: async () => ({}) }) } })
  assert.equal(r.code, 0)
  assert.match(r.text, /skipping drafting/)
  assert.equal(called, 0)
})

test("draft cli: HTTP failure → counted, exit 0, plain digest unaffected", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: false, status: 500 } }
  const r = await runCli(["digest", "--draft", iss.id], fx, { env: { SUPERVISOR_MEMORY_DRAFT_API_KEY: "k" }, fetchImpl })
  assert.equal(r.code, 0)
  assert.match(r.text, /drafting failed/)
  assert.match(r.text, /1 cumulative failure/)
  assert.equal(calls, 1)
  assert.equal(readDrafts(fx.storeRoot).failures[iss.id].count, 1)
  const d = await runCli(["digest"], fx)
  assert.equal(d.code, 0)
})

test("draft cli: timeout → exit 0, exactly one attempt", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  let calls = 0
  const fetchImpl = (url, opts) => {
    calls++
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("AbortError")))
    })
  }
  const r = await runCli(["digest", "--draft", iss.id], fx, {
    env: { SUPERVISOR_MEMORY_DRAFT_API_KEY: "k" },
    fetchImpl,
    draftTimeoutMs: 50,
  })
  assert.equal(r.code, 0)
  assert.match(r.text, /timeout/)
  assert.equal(calls, 1)
})

test("draft cli: --store-draft saves without TTY confirm; non-draft candidate refused", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const r = await runCli(["digest", "--draft", iss.id, "--store-draft"], fx, {
    env: { SUPERVISOR_MEMORY_DRAFT_API_KEY: "k" },
    io: fakeIO([], { isTTY: false }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "非交互草稿" } }] }) }),
  })
  assert.equal(r.code, 0)
  assert.equal(readDrafts(fx.storeRoot).drafts[iss.id].body, "非交互草稿")
  const r2 = await runCli(["digest", "--draft", "ISS-none"], fx, { env: { SUPERVISOR_MEMORY_DRAFT_API_KEY: "k" } })
  assert.equal(r2.code, 1)
  assert.match(r2.text, /not found/)
})

// ---------- weekly flags (D10 self-report) ----------

test("weekly: flags recorded, missing self-report fields shown as 未知", async (t) => {
  const fx = makeFixture(t)
  seedIssue(fx.storeRoot)
  const r = await runCli(["digest", "--spent-min", "12", "--dup-burden", "中等"], fx)
  assert.equal(r.code, 0)
  assert.match(r.text, /unknown/)
  assert.match(r.text, /never establish an "effort-saving" conclusion/)
  const weekly = JSON.parse(fs.readFileSync(path.join(fx.storeRoot, "digest", "weekly.json"), "utf8"))
  const week = weekly.weeks[Object.keys(weekly.weeks)[0]]
  assert.equal(String(week.selfReport.spentMinutes), "12")
  assert.equal(week.selfReport.dupBurden, "中等")
  assert.equal(week.selfReport.missedExperience, null)
  assert.equal(week.counts.candidates, 1)
  // merge with previous self-report: only new flag supplied
  const r2 = await runCli(["digest", "--missed-exp", "偶尔漏记"], fx)
  assert.equal(r2.code, 0)
  const weekly2 = JSON.parse(fs.readFileSync(path.join(fx.storeRoot, "digest", "weekly.json"), "utf8"))
  const week2 = weekly2.weeks[Object.keys(weekly2.weeks)[0]]
  assert.equal(String(week2.selfReport.spentMinutes), "12")
  assert.equal(week2.selfReport.missedExperience, "偶尔漏记")
})

// ---------- T6: zero-write matrix ----------

test("T6: read-only commands write nothing outside store/ (digest views included)", async (t) => {
  const fx = makeFixture(t)
  seedIssue(fx.storeRoot)
  const before = snapshot(fx.base)
  for (const cmd of [["digest"], ["status"], ["doctor"], ["digest", "--draft", "ISS-none"]]) {
    const r = await runCli(cmd, fx)
    assert.notEqual(r.code, 2, `command ${cmd[0]} should be recognized`)
  }
  assertOnlyStoreWrites("T6 readonly commands", fx, before)
  assert.equal(fs.readFileSync(fx.target, "utf8"), "# Project notes\n")
})

test("T6: mutating commands never touch target files", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const beforeApprove = snapshot(fx.base)
  const a = await runCli(["approve", iss.id], fx, { io: fakeIO(approveAnswers({})) })
  assert.equal(a.code, 0)
  assertOnlyStoreWrites("T6 approve", fx, beforeApprove)
  assert.equal(fs.readFileSync(fx.target, "utf8"), "# Project notes\n")
  const ruleId = openStore(fx.storeRoot).listRules()[0].id
  const beforeDisable = snapshot(fx.base)
  const d = await runCli(["disable", ruleId], fx)
  assert.equal(d.code, 0)
  assertOnlyStoreWrites("T6 disable", fx, beforeDisable)
  assert.equal(fs.readFileSync(fx.target, "utf8"), "# Project notes\n")
})

test("T6: draft failure paths write only the digest/drafts.json view", async (t) => {
  const fx = makeFixture(t)
  const iss = seedIssue(fx.storeRoot)
  const before = snapshot(fx.base)
  const r = await runCli(["digest", "--draft", iss.id], fx, {
    env: { SUPERVISOR_MEMORY_DRAFT_API_KEY: "k" },
    fetchImpl: async () => ({ ok: false, status: 500 }),
  })
  assert.equal(r.code, 0)
  const after = snapshot(fx.base)
  for (const [p, v] of after) {
    if (p === "store/digest/drafts.json") continue
    if (STORE_PREFIX.test(p) && p.startsWith("store/digest/")) continue
    assert.equal(before.get(p), v, `T6 draft failure: ${p} must not change`)
  }
  assert.ok(after.has("store/digest/drafts.json"))
})
