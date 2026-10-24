// v6.0 Part III step 1a tool-face tests (design §III.0/III.1/III.5):
// memory_draft_rule / memory_prepare_publish / memory_status, plus the description lint.
//
// Isolation mirrors test/tool.test.mjs: every test gets its own mkdtemp
// directories (fake host DB, store root, mock dir, target AGENTS.md); the
// real ~/.local/share/opencode-supervisor/ and the real host opencode.db are
// never touched — all paths injected. Approvals are recorded directly through
// store.recordDecision (the exact call runApprove makes after its TTY
// stages), so no test needs a TTY.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { initStore, openStore } from "../lib/memory/store.mjs"
import { saveDraft, readDrafts } from "../lib/memory/cli/views.mjs"
import { buildSegment, formatPatch, formatRulePatch, generateRemove } from "../lib/memory/cli/patch.mjs"
import { candidateTargets, whyTarget } from "../lib/memory/cli/targets.mjs"
import { describeScope } from "../lib/memory/cli/approve.mjs"
import { buildDraftRuleTool, BODY_DRAFTING_GUIDANCE } from "../lib/memory/draft.mjs"
import { buildPreparePublishTool } from "../lib/memory/publish.mjs"
import { buildMemoryStatusTool } from "../lib/memory/view.mjs"
import { registerMemoryTool, buildMemoryTools, FROZEN_TOOL_DESCRIPTION } from "../lib/memory/tool.mjs"

// ---------- helpers ----------

const QUICK = { lockTimeoutMs: 200, lockPollMs: 5, pidGraceMs: 10 }
const PROJ_A = "proj_a"
const PROJ_B = "proj_b"

function withTmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** Fake host opencode.db — only session_v2 (the session identity gate). */
function createHostDb(t) {
  const dir = withTmp(t, "hostdb1a-")
  const dbPath = path.join(dir, "opencode.db")
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, agent TEXT);")
  db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?)").run("ses_root_a", PROJ_A, null, "build")
  db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?)").run("ses_child_a", PROJ_A, "ses_root_a", "subagent")
  db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?)").run("ses_root_b", PROJ_B, null, "build")
  db.close()
  return dbPath
}

function makeStoreRoot(t) {
  const root = path.join(withTmp(t, "mem1a-"), "memory")
  initStore(root)
  return root
}

function makeCfg(t, { mock = false, mockDir = null } = {}) {
  return {
    enable: true,
    mock,
    dbPath: createHostDb(t),
    storeRoot: makeStoreRoot(t),
    mockDir,
  }
}

const CTX_A = { sessionID: "ses_root_a" }

// Convenience: run a tool execute and return the parsed structured receipt
// (the dual-form convention: content mirrors the structured fields).
async function executeDraftTool(cfg, args, context = CTX_A) {
  return JSON.parse((await buildDraftRuleTool({ cfg }).execute(args, context)).content)
}

async function executePrepareTool(cfg, args, context = CTX_A) {
  return JSON.parse((await buildPreparePublishTool({ cfg }).execute(args, context)).content)
}

async function executeStatusTool(cfg, args = {}, context = CTX_A) {
  return JSON.parse((await buildMemoryStatusTool({ cfg }).execute(args, context)).content)
}

/** One draft candidate in proj_a, created exactly as memory_record_correction does. */
function seedIssue(store, { projectId = PROJ_A, sessionId = "ses_root_a", messageId = "msg_x" } = {}) {
  const res = store.appendEvent({
    source: { sessionId, projectId, messageId },
    evidence: { excerpt: "seed correction", messageRef: messageId },
    issueId: null,
    title: "seed candidate",
    topic: null,
  })
  return res.event.issueId
}

/**
 * Envelope assertion for every tool failure (Oracle R33): stable MEMORY_*
 * code, one-line message carrying `fragment`, nextTool null (phase 1),
 * retry from the enum — and none of the success fields.
 */
function expectReject(res, fragment, { code, retry } = {}) {
  assert.equal(res.ok, false)
  assert.equal(res.ack, undefined, "rejection must carry no ack receipt")
  assert.equal(res.error, undefined, "old string-error shape is gone")
  assert.match(res.code, /^MEMORY_[A-Z_]+$/)
  assert.equal(typeof res.message, "string")
  assert.equal(res.nextTool, null, "phase 1 exposes no next-tool pointers")
  assert.ok(["requires_user_confirmation", "safe", "never"].includes(res.retry), `retry ${res.retry} must be in the enum`)
  if (code) assert.equal(res.code, code)
  if (retry) assert.equal(res.retry, retry)
  if (fragment) assert.ok(res.message.includes(fragment), `message ${JSON.stringify(res.message)} must include ${JSON.stringify(fragment)}`)
}

/** Project-scope AGENTS.md target + confirmed project directory registration. */
function makeTarget(t, store, { projectId = PROJ_A, confirm = true } = {}) {
  const dir = withTmp(t, "target1a-")
  const file = path.join(dir, "AGENTS.md")
  fs.writeFileSync(file, "# agents\n", { mode: 0o600 })
  store.upsertProject({ projectId, directory: dir, confirmDirectory: confirm })
  return { dir, file }
}

const APPROVE_BODY = "优先使用 const 而非 let。\n不要在库里手工修补状态。"

/** Approve a rule exactly as runApprove records it (same recordDecision call). */
function approveRule(store, { file, body = APPROVE_BODY, scope = { kind: "project", projectId: PROJ_A } }) {
  const object = {
    body,
    scope,
    targets: [file],
    reviewDate: "2026-11-22",
    channel: "patch-human-apply",
    directoryBoundary: null,
    agents: null,
  }
  return store.recordDecision({ kind: "approve", ruleId: null, object })
}

// ---------- memory_draft_rule ----------

test("memory_draft_rule: 草稿落盘 drafts.json 且与 CLI 共存(同一 saveDraft 写入函数)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const issueId = seedIssue(store)

  // CLI side writes first (the digest --draft path), then the tool overwrites
  // — one shared file and writer, last write wins per issue.
  saveDraft(cfg.storeRoot, issueId, "CLI 起草的旧正文", 1_700_000_000_000)
  assert.equal(readDrafts(cfg.storeRoot).drafts[issueId].body, "CLI 起草的旧正文")

  const res = await executeDraftTool(cfg, { issueId, body: APPROVE_BODY })
  assert.equal(res.ack, true)
  assert.equal(res.draftId, issueId)
  assert.equal(res.body, APPROVE_BODY)
  assert.match(res.note, /not approved, not in effect/)
  const view = readDrafts(cfg.storeRoot)
  assert.equal(view.drafts[issueId].body, APPROVE_BODY, "tool write lands in the shared CLI view")
  assert.ok(typeof view.drafts[issueId].ts === "number")
})

test("memory_draft_rule: 未批准 — 不产生 decision、不改候选状态", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const issueId = seedIssue(store)

  const res = await executeDraftTool(cfg, { issueId, body: APPROVE_BODY })
  assert.equal(res.ack, true)
  assert.equal(store.listDecisions().length, 0, "a draft must never produce a decision")
  assert.equal(store.getIssue(issueId).status, "draft", "candidate status unchanged")
})

test("memory_draft_rule: 不存在 / 跨项目 / 非 draft / 空正文 / 超 10 行 → 整体拒绝(无一落盘)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const issueId = seedIssue(store)
  const foreignIssueId = seedIssue(store, { projectId: PROJ_B, sessionId: "ses_root_b", messageId: "msg_b" })

  expectReject(await executeDraftTool(cfg, { issueId: "ISS-nothere", body: APPROVE_BODY }), "does not exist in the store", { code: "MEMORY_ISSUE_NOT_FOUND" })
  expectReject(await executeDraftTool(cfg, { issueId: foreignIssueId, body: APPROVE_BODY }), "another project", { code: "MEMORY_ISSUE_FOREIGN" })
  store.upsertIssue({ id: issueId, status: "approved" })
  expectReject(await executeDraftTool(cfg, { issueId, body: APPROVE_BODY }), "approved", { code: "MEMORY_NOT_DRAFTABLE" })
  expectReject(await executeDraftTool(cfg, { issueId, body: "   \n  " }), "body is empty", { code: "MEMORY_INVALID_INPUT" })
  const long = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join("\n")
  expectReject(await executeDraftTool(cfg, { issueId, body: long }), "-line limit", { code: "MEMORY_INVALID_INPUT" })
  assert.equal(Object.keys(readDrafts(cfg.storeRoot).drafts).length, 0, "nothing written on any rejection")
})

test("memory_draft_rule: 子会话调用 → 拒绝 (fail-closed)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const issueId = seedIssue(store)
  expectReject(await executeDraftTool(cfg, { issueId, body: APPROVE_BODY }, { sessionID: "ses_child_a" }), "can only be used in a root session", { code: "MEMORY_SESSION_REJECTED", retry: "never" })
  assert.equal(Object.keys(readDrafts(cfg.storeRoot).drafts).length, 0)
})

test("memory_draft_rule: store 缺失 → init 提示 + requires_user_confirmation, 目录绝不自动创建", async (t) => {
  const dir = withTmp(t, "mem1anostore-")
  const cfg = { enable: true, mock: false, dbPath: createHostDb(t), storeRoot: path.join(dir, "absent"), mockDir: null }
  expectReject(await executeDraftTool(cfg, { issueId: "ISS-x", body: APPROVE_BODY }), "init", { code: "MEMORY_STORE_MISSING", retry: "requires_user_confirmation" })
  assert.equal(fs.existsSync(cfg.storeRoot), false)
})

test("memory_draft_rule mock: 校验照常、零生产写入、隔离回执", async (t) => {
  const mockDir = withTmp(t, "mock1a-")
  const cfg = makeCfg(t, { mock: true, mockDir })
  const store = openStore(cfg.storeRoot, QUICK)
  const issueId = seedIssue(store)

  const res = await executeDraftTool(cfg, { issueId, body: APPROVE_BODY })
  assert.equal(res.ack, true)
  assert.equal(res.mock, true)
  assert.equal(res.draftId, issueId)
  assert.equal(fs.existsSync(path.join(cfg.storeRoot, "digest", "drafts.json")), false, "mock must not write the production view")
  const receipts = fs.readFileSync(path.join(mockDir, "ses_root_a.jsonl"), "utf8").trim().split("\n")
  assert.equal(JSON.parse(receipts[0]).tool, "memory_draft_rule")
})

// ---------- memory_prepare_publish ----------

test("memory_prepare_publish: 未批准 → 拒绝(不存在 / draft 候选 id / 已停用)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const approved = approveRule(store, { file })
  const issueId = seedIssue(store)

  expectReject(await executePrepareTool(cfg, { ruleId: "RUL-nothere" }), "does not exist in the store", { code: "MEMORY_RULE_NOT_FOUND" })
  expectReject(await executePrepareTool(cfg, { ruleId: issueId }), "does not exist in the store", { code: "MEMORY_RULE_NOT_FOUND" })
  store.recordDecision({ kind: "disable", ruleId: approved.rule.id })
  expectReject(await executePrepareTool(cfg, { ruleId: approved.rule.id }), "is disabled", { code: "MEMORY_RULE_DISABLED" })
})

test("memory_prepare_publish: 补丁文本与 CLI 生成为字节一致, 回执明示未应用", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const body = APPROVE_BODY
  const { rule } = approveRule(store, { file, body })

  const res = await executePrepareTool(cfg, { ruleId: rule.id })
  assert.equal(res.ok, true)
  assert.equal(res.applied, false)
  assert.equal(res.patches.length, 1)
  assert.equal(res.patches[0].path, file)
  assert.match(res.note, /not applied/)
  assert.match(res.note, /human-review CLI/)

  // Byte-identical to the CLI approve printer for the same object: the shared
  // formatRulePatch composition with the CURRENT candidate context (note is
  // whatever gitTracked reports here) and previous = null for v1.
  const c = candidateTargets({ scope: rule.scope, projects: store.listProjects(), cwd: null, home: os.homedir() }).find(
    (x) => x.path === file,
  )
  assert.ok(c, "target must be an in-scope candidate")
  const expected = formatRulePatch({
    targetPath: file,
    why: whyTarget(c),
    scopePromise: describeScope(rule.scope),
    trackedNote: c.note,
    fileContent: fs.readFileSync(file, "utf8"),
    ruleId: rule.id,
    version: rule.version,
    body,
    previous: null,
  })
  assert.equal(res.patches[0].patch, expected)
  assert.match(res.patches[0].patch, new RegExp(`supervisor-memory:rule:${rule.id}:v1`))
})

test("memory_prepare_publish: 目标不满足 D8 → 拒绝(文件缺失 / 范围不一致 / marker 异常)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const { rule } = approveRule(store, { file })

  // file missing → never create new files
  fs.rmSync(file)
  expectReject(await executePrepareTool(cfg, { ruleId: rule.id }), "does not exist", { code: "MEMORY_TARGET_REJECTED", retry: "requires_user_confirmation" })
  fs.writeFileSync(file, "# agents\n", { mode: 0o600 })

  // scope mismatch: a rule approved for proj_b cannot target proj_a's file
  const foreign = approveRule(store, { file, scope: { kind: "project", projectId: PROJ_B } })
  expectReject(await executePrepareTool(cfg, { ruleId: foreign.rule.id }), "inconsistent with the rule's approved scope", { code: "MEMORY_TARGET_REJECTED" })

  // marker anomaly in target → fail-closed, human review (the patch builder
  // raises in English; the tool wraps it verbatim under 补丁生成失败)
  fs.writeFileSync(file, "<!-- supervisor-memory:rule:orphan:v1 -->\n", { mode: 0o600 })
  expectReject(await executePrepareTool(cfg, { ruleId: rule.id }), "fail-closed", { code: "MEMORY_TARGET_REJECTED" })
})

test("memory_prepare_publish: 目录未确认 → 拒绝(目录确认是人的显式操作)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store, { confirm: false })
  const { rule } = approveRule(store, { file })
  expectReject(await executePrepareTool(cfg, { ruleId: rule.id }), "unconfirmed", { code: "MEMORY_TARGET_REJECTED", retry: "requires_user_confirmation" })
})

test("memory_prepare_publish mode=remove: 移除补丁与 CLI disable 打印字节一致, removed 内容=受管段; 无段→skipped", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const { rule } = approveRule(store, { file, body: APPROVE_BODY })

  // no segment applied yet → ok, nothing to remove, reported as skipped
  const before = await executePrepareTool(cfg, { ruleId: rule.id, mode: "remove" })
  assert.equal(before.ok, true)
  assert.equal(before.mode, "remove")
  assert.equal(before.applied, false)
  assert.deepEqual(before.patches, [])
  assert.equal(before.skipped.length, 1)
  assert.match(before.skipped[0].reason, /no managed segment/)

  // simulate the human having pasted the v1 segment into the target
  fs.writeFileSync(file, `# agents\n${buildSegment(rule.id, 1, APPROVE_BODY)}\n`, { mode: 0o600 })
  const res = await executePrepareTool(cfg, { ruleId: rule.id, mode: "remove" })
  assert.equal(res.ok, true)
  assert.equal(res.skipped, undefined, "nothing skipped once a segment exists")
  assert.equal(res.patches.length, 1)
  assert.equal(res.patches[0].path, file)
  assert.match(res.note, /not applied/)

  // byte-identical to the CLI disable printer for the same target state
  const cli = generateRemove(fs.readFileSync(file, "utf8"), { ruleId: rule.id })
  assert.equal(cli.length, 1)
  const expected = formatPatch({
    targetPath: file,
    why: "known publish target of the disabled rule",
    scopePromise: "removes the entire managed segment (all versions)",
    tracked: cli[0].notes?.join("; ") || "see file",
    patch: cli[0],
  })
  assert.equal(res.patches[0].patch, expected)

  // the quoted removed content is exactly the managed segment (marker pair + body)
  for (const l of buildSegment(rule.id, 1, APPROVE_BODY).split("\n")) {
    assert.ok(res.patches[0].patch.includes(`  | ${l}`), `removal patch must quote the segment line: ${l}`)
  }
  assert.match(res.patches[0].patch, new RegExp(`supervisor-memory:rule:${rule.id}:v1`))
})

test("memory_prepare_publish mode=remove: 多版本段逐段出补丁(同 CLI disable), apply 显式缺省行为不变", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const body2 = `${APPROVE_BODY}\nv2 追加行`
  const { rule } = approveRule(store, { file, body: APPROVE_BODY })
  store.recordDecision({
    kind: "approve",
    ruleId: rule.id,
    object: {
      body: body2,
      scope: { kind: "project", projectId: PROJ_A },
      targets: [file],
      reviewDate: "2026-11-22",
      channel: "patch-human-apply",
      directoryBoundary: null,
      agents: null,
    },
  })
  assert.equal(store.getRule(rule.id).version, 2)

  // both v1 and v2 segments present in the target (human pasted both)
  fs.writeFileSync(
    file,
    `# agents\n${buildSegment(rule.id, 1, APPROVE_BODY)}\n${buildSegment(rule.id, 2, body2)}\n`,
    { mode: 0o600 },
  )
  const res = await executePrepareTool(cfg, { ruleId: rule.id, mode: "remove" })
  assert.equal(res.ok, true)
  assert.equal(res.patches.length, 2, "one patch per present segment, like the CLI disable printer")
  assert.deepEqual(res.patches.map((p) => p.version), [1, 2])

  const cli = generateRemove(fs.readFileSync(file, "utf8"), { ruleId: rule.id })
  assert.equal(cli.length, 2)
  res.patches.forEach((p, i) => {
    assert.equal(p.patch, formatPatch({
      targetPath: file,
      why: "known publish target of the disabled rule",
      scopePromise: "removes the entire managed segment (all versions)",
      tracked: cli[i].notes?.join("; ") || "see file",
      patch: cli[i],
    }))
  })

  // explicit mode:"apply" is the unchanged default behavior (byte-identity
  // with the CLI approve printer, asserted in detail by the test above)
  const applied = await executePrepareTool(cfg, { ruleId: rule.id, mode: "apply" })
  assert.equal(applied.ok, true)
  assert.equal(applied.mode, "apply")
  assert.equal(applied.patches.length, 1)
  assert.match(applied.patches[0].patch, new RegExp(`supervisor-memory:rule:${rule.id}:v2`))
})

test("memory_prepare_publish mode=remove: system-ride 规则 → RULE_NO_TARGETS; 非法 mode → INVALID_INPUT", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const { rule } = store.recordDecision({
    kind: "approve",
    ruleId: null,
    object: {
      body: "ride 通道规则\n",
      scope: { kind: "project", projectId: PROJ_A },
      targets: [],
      reviewDate: "2026-11-22",
      channel: "system-ride",
      directoryBoundary: null,
      agents: null,
    },
  })
  expectReject(await executePrepareTool(cfg, { ruleId: rule.id, mode: "remove" }), "no registered targets", { code: "MEMORY_RULE_NO_TARGETS" })
  expectReject(await executePrepareTool(cfg, { ruleId: rule.id, mode: "rewind" }), 'mode must be "apply" or "remove"', { code: "MEMORY_INVALID_INPUT" })
  assert.equal(fs.readFileSync(file, "utf8"), "# agents\n", "rejections never touched the target file")
})

// ---------- memory_status ----------

test("memory_status: 只含本项目(含全局), 不含他项目/目录范围规则与审批细节", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)

  const a1 = approveRule(store, { file, body: "项目 A 规则一\n" })
  const a2 = approveRule(store, { file, body: "项目 A 规则二\n" })
  const b1 = approveRule(store, { file, body: "项目 B 规则\n", scope: { kind: "project", projectId: PROJ_B } })
  const g1 = approveRule(store, { file, body: "全局规则\n", scope: { kind: "user-global" } })
  const d1 = approveRule(store, {
    file,
    body: "目录范围规则\n",
    scope: { kind: "directory", directory: path.dirname(file) },
  })
  assert.ok([a1, a2, b1, g1, d1].every((r) => r.rule.id.startsWith("RUL-")))

  const issue1 = seedIssue(store)
  seedIssue(store, { messageId: "msg_y" })
  store.upsertIssue({ id: issue1, status: "approved" })

  const res = await executeStatusTool(cfg)
  assert.equal(res.ok, true)
  assert.equal(res.projectId, PROJ_A)
  const ids = res.rules.map((r) => r.id)
  assert.ok(ids.includes(a1.rule.id), "own project rule visible")
  assert.ok(ids.includes(a2.rule.id), "own project rule visible")
  assert.ok(ids.includes(g1.rule.id), "user-global rule visible")
  assert.ok(!ids.includes(b1.rule.id), "other project's rule NOT visible")
  assert.ok(!ids.includes(d1.rule.id), "directory-scope rule NOT visible")
  for (const r of res.rules) {
    assert.deepEqual(Object.keys(r).sort(), ["id", "status", "summary", "version"], "minimal fields only")
    assert.equal(typeof r.summary, "string")
  }
  assert.equal(res.pending.candidates, 1, "one draft candidate left")
  assert.equal(res.pending.events, 2)
  assert.ok(JSON.stringify(res).includes("digest"), "the human review entry point is named")
})

test("memory_status: 空库 → 空列表与零计数, 仍只读", async (t) => {
  const cfg = makeCfg(t)
  const res = await executeStatusTool(cfg)
  assert.equal(res.ok, true)
  assert.deepEqual(res.rules, [])
  assert.deepEqual(res.pending, { candidates: 0, events: 0, items: [] })
  assert.equal(openStore(cfg.storeRoot, QUICK).listDecisions().length, 0)
})

// ---------- memory_status R33 phase 4: project-filtered pending + per-ID details ----------

test("memory_status: pending 计数与列表按项目过滤 — A 看不到 B 的候选/事件, user-global 规则两项目均可见", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const g = approveRule(store, { file, body: "全局规则\n", scope: { kind: "user-global" } })
  const aIss = seedIssue(store, { messageId: "msg_a1" })
  const bIss = seedIssue(store, { projectId: PROJ_B, sessionId: "ses_root_b", messageId: "msg_b1" })

  const a = await executeStatusTool(cfg)
  assert.equal(a.projectId, PROJ_A)
  assert.equal(a.pending.candidates, 1, "only project A's draft candidates counted")
  assert.equal(a.pending.events, 1, "only project A's pending events counted")
  assert.deepEqual(a.pending.items.map((i) => i.id), [aIss])
  assert.ok(!JSON.stringify(a.pending).includes(bIss), "project B's candidate must not leak into project A's pending view")
  assert.ok(a.rules.some((r) => r.id === g.rule.id), "user-global rule visible from project A")

  const b = await executeStatusTool(cfg, {}, { sessionID: "ses_root_b" })
  assert.equal(b.projectId, PROJ_B)
  assert.equal(b.pending.candidates, 1)
  assert.equal(b.pending.events, 1)
  assert.deepEqual(b.pending.items.map((i) => i.id), [bIss])
  assert.ok(!JSON.stringify(b.pending).includes(aIss), "project A's candidate must not leak into project B's pending view")
  assert.ok(b.rules.some((r) => r.id === g.rule.id), "user-global rule visible from project B")
})

test("memory_status: pending.items 形状/草稿状态/单行摘录; >20 条时限 20 而计数不截断", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  for (let n = 0; n < 25; n++) seedIssue(store, { messageId: `msg_${n}`, title: `候选 ${n}\n第二行` })

  const res = await executeStatusTool(cfg)
  assert.equal(res.pending.candidates, 25, "counts stay uncapped project totals")
  assert.equal(res.pending.items.length, 20, "item list is capped at 20")
  for (const item of res.pending.items) {
    assert.deepEqual(Object.keys(item).sort(), ["draftStatus", "excerpt", "firstSeenTs", "id"])
    assert.equal(typeof item.firstSeenTs, "number")
    assert.equal(item.draftStatus, "none")
    assert.ok(!item.excerpt.includes("\n"), "excerpt is one line")
  }

  // a stored draft flips the item's draftStatus (shared drafts.json view)
  saveDraft(cfg.storeRoot, res.pending.items[0].id, "草稿正文", Date.now())
  const after = await executeStatusTool(cfg)
  assert.equal(after.pending.items.find((i) => i.id === res.pending.items[0].id).draftStatus, "drafted")
})

test("memory_status: id=详情 — 本项目规则全文/候选证据; 他项目/目录范围/未知 → NOT_FOUND 不暴露存在性", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const body = "项目规则全文\n第二行\n"
  const { rule } = approveRule(store, { file, body })
  const g = approveRule(store, { file, body: "全局规则\n", scope: { kind: "user-global" } })
  const b = approveRule(store, { file, body: "B 项目秘密规则\n", scope: { kind: "project", projectId: PROJ_B } })
  const d = approveRule(store, { file, body: "目录范围规则\n", scope: { kind: "directory", directory: path.dirname(file) } })
  const iss = seedIssue(store, { messageId: "msg_det", title: "详情候选" })

  // own project rule: full body + scope/channel/version/status/agents
  const rd = await executeStatusTool(cfg, { id: rule.id })
  assert.equal(rd.ok, true)
  assert.deepEqual(rd.details, {
    kind: "rule",
    id: rule.id,
    status: "active",
    version: 1,
    body,
    scope: { kind: "project", projectId: PROJ_A },
    channel: "patch-human-apply",
    agents: null,
  })

  // user-global rule visible from any project
  const gd = await executeStatusTool(cfg, { id: g.rule.id })
  assert.equal(gd.details.kind, "rule")
  assert.deepEqual(gd.details.scope, { kind: "user-global" })

  // candidate: evidence excerpts + sources + draft status
  const isd = await executeStatusTool(cfg, { id: iss })
  assert.deepEqual(Object.keys(isd.details).sort(), ["draftStatus", "evidence", "id", "kind", "projectId", "recurrence", "status", "title"])
  assert.equal(isd.details.kind, "issue")
  assert.equal(isd.details.status, "draft")
  assert.equal(isd.details.draftStatus, "none")
  assert.equal(isd.details.projectId, PROJ_A)
  assert.equal(isd.details.evidence.length, 1)
  assert.equal(isd.details.evidence[0].excerpt, "seed correction")
  assert.equal(isd.details.evidence[0].source.projectId, PROJ_A)

  // out-of-scope / directory-scope / unknown → same NOT_FOUND envelope,
  // existence (or content) never leaks
  for (const foreign of [b.rule.id, d.rule.id, "RUL-nope", "ISS-nope"]) {
    expectReject(await executeStatusTool(cfg, { id: foreign }), "not visible in this scope", { code: "MEMORY_NOT_FOUND", retry: "never" })
  }
  const raw = await executeStatusTool(cfg, { id: b.rule.id })
  assert.ok(!JSON.stringify(raw).includes("B 项目秘密规则"), "NOT_FOUND must not carry the foreign rule's content")
  expectReject(await executeStatusTool(cfg, { id: "garbage" }), "RUL-", { code: "MEMORY_INVALID_INPUT" })
})

test("memory_status: id=详情 草稿状态反映 drafts.json; 默认视图(无 id)不携带 details 字段", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  makeTarget(t, store)
  const iss = seedIssue(store, { messageId: "msg_draft_det" })
  saveDraft(cfg.storeRoot, iss, "已起草正文", Date.now())

  const res = await executeStatusTool(cfg, { id: iss })
  assert.equal(res.details.draftStatus, "drafted")
  assert.equal(res.details.recurrence, 1)

  const plain = await executeStatusTool(cfg)
  assert.equal(plain.details, undefined, "no id argument → no details field")
})

// ---------- tool face shape (III.0 lint + registration) ----------

test("描述 lint: 工具描述无步骤指导/句式处方, schema 无 confirmed/approved 类参数, 均 codemode:false", () => {
  const tools = buildMemoryTools({ cfg: { enable: true, mock: false, dbPath: null, storeRoot: null, mockDir: null } })
  assert.deepEqual(
    tools.map((tl) => tl.name),
    [
      "memory_record_correction",
      "memory_draft_rule",
      "memory_prepare_publish",
      "memory_status",
      "memory_approve_rule",
      "memory_enable_delivery",
      "memory_disable_delivery",
      "memory_disable_rule",
    ],
  )
  const LINT_RE = /首先|然后|步骤|依次|请先|句式|祈使|建议你|你应该/
  for (const tool of tools) {
    assert.match(tool.description, /\S/)
    assert.equal(LINT_RE.test(tool.description), false, `description of ${tool.name} must stay lint-clean: ${tool.description}`)
    assert.deepEqual(tool.options, { codemode: false }, `${tool.name} must set codemode:false`)
    for (const p of Object.keys(tool.input?.properties ?? {})) {
      // confirmTimeoutMin is a WAIT DURATION, never an authorization artifact;
      // everything else matching the authorization vocabulary is forbidden —
      // the model can never provide confirmation state (R33 §②).
      if (p === "confirmTimeoutMin") continue
      assert.ok(!/confirm|approv/i.test(p), `${tool.name}.${p} must not be an authorization parameter`)
    }
  }
  assert.equal(tools[0].description, FROZEN_TOOL_DESCRIPTION)
})

test("起草指引: draft 与 approve 的 body 参数描述都携带自然语言/防中英混写指引(仅指引, 无校验器)", async (t) => {
  const tools = buildMemoryTools({ cfg: { enable: true, mock: false, dbPath: null, storeRoot: null, mockDir: null } })
  const guidance = BODY_DRAFTING_GUIDANCE
  assert.match(guidance, /自然语言或简洁 Markdown/)
  assert.match(guidance, /不要复制整段工具调用封装、回执 JSON/)
  assert.match(guidance, /避免无必要的中英文混写/)
  for (const name of ["memory_draft_rule", "memory_approve_rule"]) {
    const tool = tools.find((tl) => tl.name === name)
    assert.ok(tool, `${name} registered`)
    const desc = tool.input?.properties?.body?.description ?? ""
    assert.ok(desc.includes(guidance), `${name}.body description must carry the drafting guidance verbatim`)
  }
  // guidance only: a body full of tool-call wrappers is still accepted (no validator, no auto-deletion)
  const cfg = makeCfg(t)
  const issueId = seedIssue(openStore(cfg.storeRoot, QUICK))
  const wrapped = '先调用 foo(bar="x")，返回 {"ok":true} 后执行下述规范：\n规范第二行'
  const res = await executeDraftTool(cfg, { issueId, body: wrapped })
  assert.equal(res.ack, true, "no validator rejects wrapper-style bodies")
})

test("注册: 新三工具与 memory_record_correction 同机制注册(同 ctx, 一次 reload)", async (t) => {
  const dbPath = createHostDb(t)
  const storeRoot = makeStoreRoot(t)
  const state = { added: [], reloaded: 0 }
  const ctx = {
    options: { memory: { enable: true, dbPath, storeRoot } },
    tool: {
      transform(fn) {
        fn({
          add(tool) {
            state.added.push(tool)
          },
        })
      },
      async reload() {
        state.reloaded++
      },
    },
  }
  const res = await registerMemoryTool(ctx)
  assert.equal(res.registered, true)
  assert.equal(state.reloaded, 1)
  assert.deepEqual(state.added.map((tl) => tl.name), [
    "memory_record_correction",
    "memory_draft_rule",
    "memory_prepare_publish",
    "memory_status",
    "memory_approve_rule",
    "memory_enable_delivery",
    "memory_disable_delivery",
    "memory_disable_rule",
  ])
  // dual-form receipt convention holds for the new tools too
  const status = state.added.find((tl) => tl.name === "memory_status")
  const out = await status.execute({}, CTX_A)
  assert.equal(typeof out.content, "string")
  assert.equal(JSON.parse(out.content).ok, true)
})
