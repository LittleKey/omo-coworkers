// v6.0 Part III step 1a tool-face tests (design §III.0/III.1/III.5):
// draft_rule / prepare_publish / memory_status, plus the description lint.
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
import { formatRulePatch } from "../lib/memory/cli/patch.mjs"
import { candidateTargets, whyTarget } from "../lib/memory/cli/targets.mjs"
import { describeScope } from "../lib/memory/cli/approve.mjs"
import { buildDraftRuleTool } from "../lib/memory/draft.mjs"
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

/** One draft candidate in proj_a, created exactly as report_correction does. */
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

function expectReject(res, fragment) {
  assert.equal(res.ok, false)
  assert.equal(res.ack, undefined, "rejection must carry no ack receipt")
  assert.equal(typeof res.error, "string")
  if (fragment) assert.ok(res.error.includes(fragment), `error ${JSON.stringify(res.error)} must include ${JSON.stringify(fragment)}`)
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

// ---------- draft_rule ----------

test("draft_rule: 草稿落盘 drafts.json 且与 CLI 共存(同一 saveDraft 写入函数)", async (t) => {
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

test("draft_rule: 未批准 — 不产生 decision、不改候选状态", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const issueId = seedIssue(store)

  const res = await executeDraftTool(cfg, { issueId, body: APPROVE_BODY })
  assert.equal(res.ack, true)
  assert.equal(store.listDecisions().length, 0, "a draft must never produce a decision")
  assert.equal(store.getIssue(issueId).status, "draft", "candidate status unchanged")
})

test("draft_rule: 不存在 / 跨项目 / 非 draft / 空正文 / 超 10 行 → 整体拒绝(无一落盘)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const issueId = seedIssue(store)
  const foreignIssueId = seedIssue(store, { projectId: PROJ_B, sessionId: "ses_root_b", messageId: "msg_b" })

  expectReject(await executeDraftTool(cfg, { issueId: "ISS-nothere", body: APPROVE_BODY }), "does not exist in the store")
  expectReject(await executeDraftTool(cfg, { issueId: foreignIssueId, body: APPROVE_BODY }), "another project")
  store.upsertIssue({ id: issueId, status: "approved" })
  expectReject(await executeDraftTool(cfg, { issueId, body: APPROVE_BODY }), "approved")
  expectReject(await executeDraftTool(cfg, { issueId, body: "   \n  " }), "body is empty")
  const long = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join("\n")
  expectReject(await executeDraftTool(cfg, { issueId, body: long }), "-line limit")
  assert.equal(Object.keys(readDrafts(cfg.storeRoot).drafts).length, 0, "nothing written on any rejection")
})

test("draft_rule: 子会话调用 → 拒绝 (fail-closed)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const issueId = seedIssue(store)
  expectReject(await executeDraftTool(cfg, { issueId, body: APPROVE_BODY }, { sessionID: "ses_child_a" }), "can only be used in a root session")
  assert.equal(Object.keys(readDrafts(cfg.storeRoot).drafts).length, 0)
})

test("draft_rule: store 缺失 → init 提示, 目录绝不自动创建", async (t) => {
  const dir = withTmp(t, "mem1anostore-")
  const cfg = { enable: true, mock: false, dbPath: createHostDb(t), storeRoot: path.join(dir, "absent"), mockDir: null }
  expectReject(await executeDraftTool(cfg, { issueId: "ISS-x", body: APPROVE_BODY }), "init")
  assert.equal(fs.existsSync(cfg.storeRoot), false)
})

test("draft_rule mock: 校验照常、零生产写入、隔离回执", async (t) => {
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
  assert.equal(JSON.parse(receipts[0]).tool, "draft_rule")
})

// ---------- prepare_publish ----------

test("prepare_publish: 未批准 → 拒绝(不存在 / draft 候选 id / 已停用)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const approved = approveRule(store, { file })
  const issueId = seedIssue(store)

  expectReject(await executePrepareTool(cfg, { ruleId: "RUL-nothere" }), "does not exist in the store")
  expectReject(await executePrepareTool(cfg, { ruleId: issueId }), "does not exist in the store")
  store.recordDecision({ kind: "disable", ruleId: approved.rule.id })
  expectReject(await executePrepareTool(cfg, { ruleId: approved.rule.id }), "is disabled")
})

test("prepare_publish: 补丁文本与 CLI 生成为字节一致, 回执明示未应用", async (t) => {
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

test("prepare_publish: 目标不满足 D8 → 拒绝(文件缺失 / 范围不一致 / marker 异常)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store)
  const { rule } = approveRule(store, { file })

  // file missing → never create new files
  fs.rmSync(file)
  expectReject(await executePrepareTool(cfg, { ruleId: rule.id }), "does not exist")
  fs.writeFileSync(file, "# agents\n", { mode: 0o600 })

  // scope mismatch: a rule approved for proj_b cannot target proj_a's file
  const foreign = approveRule(store, { file, scope: { kind: "project", projectId: PROJ_B } })
  expectReject(await executePrepareTool(cfg, { ruleId: foreign.rule.id }), "inconsistent with the rule's approved scope")

  // marker anomaly in target → fail-closed, human review (the patch builder
  // raises in English; the tool wraps it verbatim under 补丁生成失败)
  fs.writeFileSync(file, "<!-- supervisor-memory:rule:orphan:v1 -->\n", { mode: 0o600 })
  expectReject(await executePrepareTool(cfg, { ruleId: rule.id }), "fail-closed")
})

test("prepare_publish: 目录未确认 → 拒绝(目录确认是人的显式操作)", async (t) => {
  const cfg = makeCfg(t)
  const store = openStore(cfg.storeRoot, QUICK)
  const { file } = makeTarget(t, store, { confirm: false })
  const { rule } = approveRule(store, { file })
  expectReject(await executePrepareTool(cfg, { ruleId: rule.id }), "unconfirmed")
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
  assert.deepEqual(res.pending, { candidates: 0, events: 0 })
  assert.equal(openStore(cfg.storeRoot, QUICK).listDecisions().length, 0)
})

// ---------- tool face shape (III.0 lint + registration) ----------

test("描述 lint: 四工具描述无步骤指导/句式处方, schema 无 confirmed/approved 类参数, 均 codemode:false", () => {
  const tools = buildMemoryTools({ cfg: { enable: true, mock: false, dbPath: null, storeRoot: null, mockDir: null } })
  assert.deepEqual(
    tools.map((tl) => tl.name),
    ["report_correction", "draft_rule", "prepare_publish", "memory_status"],
  )
  const LINT_RE = /首先|然后|步骤|依次|请先|句式|祈使|建议你|你应该/
  for (const tool of tools) {
    assert.match(tool.description, /\S/)
    assert.equal(LINT_RE.test(tool.description), false, `description of ${tool.name} must stay lint-clean: ${tool.description}`)
    assert.deepEqual(tool.options, { codemode: false }, `${tool.name} must set codemode:false`)
    for (const p of Object.keys(tool.input?.properties ?? {})) {
      assert.ok(!/confirm|approv/i.test(p), `${tool.name}.${p} must not be an authorization parameter`)
    }
  }
  assert.equal(tools[0].description, FROZEN_TOOL_DESCRIPTION)
})

test("注册: 新三工具与 report_correction 同机制注册(同 ctx, 一次 reload)", async (t) => {
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
  assert.deepEqual(state.added.map((tl) => tl.name), ["report_correction", "draft_rule", "prepare_publish", "memory_status"])
  // dual-form receipt convention holds for the new tools too
  const status = state.added.find((tl) => tl.name === "memory_status")
  const out = await status.execute({}, CTX_A)
  assert.equal(typeof out.content, "string")
  assert.equal(JSON.parse(out.content).ok, true)
})
