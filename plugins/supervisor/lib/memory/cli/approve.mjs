// `approve <issueId|ruleId>` — D6 three-stage TTY approval (m1-plan §2 D6,
// design I.6). Stage 1: pick and confirm target(s). Stage 2: show the FULL
// approval object. Stage 3: confirm; on confirm the object canonicalJson hash
// and a store fingerprint are recomputed and compared with what stage 2 showed
// — any change invalidates the confirmation (no silent retry, explicit error,
// exit 1). The decision is recorded via store.recordDecision with the object
// hash. Approval success ≠ applied: P4 patches are PRINTED for manual apply;
// the CLI never writes target files.
//
// Non-TTY → refuse. Incomplete-commit store → requireHealthy() throws (D5).
// An approve is never recorded without at least one selectable, confirmed,
// existing target (未绑定目标的 approve 不得记完成). IO methods may be sync
// (test fakes) or async (real readline) — every call is awaited.
import fs from "node:fs"
import path from "node:path"
import { canonicalJson, sha256Hex } from "../store.mjs"
import { candidateTargets, whyTarget } from "./targets.mjs"
import { formatRulePatch, generatePatch, countBodyLines, BODY_MAX_LINES } from "./patch.mjs"
import { readDrafts } from "./views.mjs"

/** Store-state fingerprint captured at stage 2 and re-verified at stage 3 (T3). */
export function fingerprint(store, ruleId, issueId) {
  const decisions = store.listDecisions()
  const rule = ruleId ? store.getRule(ruleId) : null
  const issue = issueId ? store.getIssue(issueId) : null
  return {
    decisionsTotal: decisions.length,
    rule: rule
      ? {
          version: rule.version,
          status: rule.status,
          updatedAtTs: rule.updatedAtTs,
          decisionId: rule.approvalRef?.decisionId ?? null,
        }
      : null,
    issue: issue ? { status: issue.status, updatedAtTs: issue.updatedAtTs } : null,
  }
}

function sameFingerprint(a, b) {
  return canonicalJson(a) === canonicalJson(b)
}

export function describeScope(scope) {
  if (scope.kind === "user-global") return "user-global — 全局 ~/.config/opencode/AGENTS.md(所有项目加载)"
  if (scope.kind === "project") return `project — 项目 ${scope.projectId} 的根 AGENTS.md(已确认目录)`
  return `directory — ${scope.directory} 子树的 AGENTS.md(仅该目录内会话加载)`
}

async function inputDate(io, prompt, fallback) {
  for (;;) {
    const v = await io.input(prompt, fallback)
    if (v.trim() === "" || /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim() || fallback
    io.print("  日期格式应为 YYYY-MM-DD, 请重试(空 = 采用默认)。")
  }
}

function parseSelections(s, max) {
  const out = []
  for (const part of s.split(/[,，\s]+/)) {
    if (part === "") continue
    const n = Number(part)
    if (!Number.isInteger(n) || n < 1 || n > max) return null
    out.push(n - 1)
  }
  return out.length > 0 ? out : null
}

/**
 * @param ctx {store, io, cwd, home, env}
 * @param id issue id (ISS-…) or rule id (RUL-…)
 * @returns {{code:number, patches?:string[], ruleId?:string}}
 */
export async function runApprove(ctx, id) {
  const { store, io, cwd, home } = ctx
  if (!io.isTTY) {
    io.print("拒绝: approve 是三段式人工确认, 必须在交互终端(TTY)中运行; 非 TTY 环境不接受批准。")
    return { code: 1 }
  }
  if (typeof id !== "string" || id.length === 0) {
    io.print("用法: supervisor-memory approve <issueId|ruleId>")
    return { code: 1 }
  }
  store.requireHealthy() // D5: incomplete/corrupt/locked → explicit refusal

  // ---- resolve subject: issue draft or existing rule ----
  let issue = null
  let rule = null
  if (id.startsWith("RUL-")) {
    rule = store.getRule(id)
    if (!rule) {
      io.print(`未找到规则 ${id}。`)
      return { code: 1 }
    }
    if (rule.status === "disabled") {
      io.print(`拒绝: 规则 ${id} 已停用。停用是人的决定, 重新启用需要全新的审批对象(enable 流程), 不能通过再次 approve 静默复活。`)
      return { code: 1 }
    }
  } else {
    issue = store.getIssue(id)
    if (!issue) {
      io.print(`未找到候选 ${id}(候选以 ISS- 开头; 规则以 RUL- 开头)。`)
      return { code: 1 }
    }
    if (issue.status !== "draft") {
      const why =
        issue.status === "approved"
          ? "已批准(批准成功 ≠ 已落地; 补丁以当时输出为准)。重复批准/重新上报/合并不恢复或扩大授权。"
          : issue.status === "merged"
            ? `已并入 ${issue.mergedInto}。请对该目标候选操作; 原始事件来源保留不变。`
            : "已丢弃(误报或放弃)。重新上报同一事实只会重复计数, 不恢复授权。"
      io.print(`拒绝: 候选 ${id} 当前状态为 ${issue.status} — ${why}`)
      return { code: 1 }
    }
  }

  const projectId = issue?.projectId ?? rule?.scope?.projectId ?? null
  const nextVersion = (rule?.version ?? 0) + 1

  // ---- body ----
  let body = null
  const draftsView = readDrafts(store.root)
  const draftEntry = issue ? draftsView.drafts[issue.id] : null
  if (draftEntry?.body) {
    io.print("已存草稿正文:")
    io.print(draftEntry.body)
    if (await io.confirm("采用该草稿作为规则正文?")) body = draftEntry.body
  }
  if (body === null && rule) {
    io.print("现版本正文:")
    io.print(rule.body)
    if (await io.confirm("沿用现版本正文?")) body = rule.body
  }
  if (body === null) {
    io.print("输入规则正文: 逐行输入, 单独一行输入 . 结束。")
    body = await io.inputLines("正文")
  }
  body = String(body).replace(/\r\n/g, "\n").replace(/\s+$/, "")
  if (body.trim().length === 0) {
    io.print("拒绝: 正文为空。")
    return { code: 1 }
  }
  if (countBodyLines(body) > BODY_MAX_LINES) {
    io.print(`拒绝: 正文 ${countBodyLines(body)} 行超过 ${BODY_MAX_LINES} 行上限 — 补丁会整体失败, 请精简后重试(不截断)。`)
    return { code: 1 }
  }

  // ---- scope ----
  const scopeOptions = []
  if (projectId) scopeOptions.push({ kind: "project", label: `project — 项目 ${projectId} 根 AGENTS.md` })
  scopeOptions.push({ kind: "user-global", label: "user-global — 全局 AGENTS.md" })
  scopeOptions.push({ kind: "directory", label: "directory — 指定目录的 AGENTS.md(仅该子树)" })
  io.print("选择范围:")
  const scopeIdx = await io.choose("范围", scopeOptions.map((o) => o.label))
  const scopeKind = scopeOptions[scopeIdx].kind
  let scope
  if (scopeKind === "project") {
    scope = { kind: "project", projectId }
  } else if (scopeKind === "user-global") {
    scope = { kind: "user-global" }
  } else {
    const dir = await io.input("目录绝对路径", cwd)
    if (!path.isAbsolute(dir)) {
      io.print("拒绝: 目录范围需要绝对路径。")
      return { code: 1 }
    }
    scope = { kind: "directory", directory: path.resolve(dir) }
  }

  // ---- agent restriction: cannot be honored through AGENTS.md (load scope
  // does not distinguish agents) → keep unpublished with a reason, no record. ----
  const agentsRaw = await io.input("限制生效的 agent(逗号分隔, 空 = 不限制)", "")
  const agents = agentsRaw.split(/[,，\s]+/).filter(Boolean)
  if (agents.length > 0) {
    io.print("保持未发布: agent 限制无法经 AGENTS.md 加载范围兑现(该文件按目录加载, 不区分 agent), v1 CLI 不记录此类批准。")
    io.print(`原因: 请求的 agent 范围 = ${agents.join(", ")}; 可兑现范围只有 user-global / project / directory。`)
    return { code: 1 }
  }

  const defaultReview = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const reviewDate = await inputDate(io, "复查日期(YYYY-MM-DD, 空 = 30 天后)", defaultReview)
  const channel = "patch-human-apply"

  // ---- stage 1: targets (existing files only; per-target confirmation) ----
  const projects = store.listProjects()
  const candidates = candidateTargets({ scope, projects, cwd, home })
  io.print("候选目标(永不创建新文件; 文件不存在 = 不可选):")
  candidates.forEach((c, i) => {
    const flag = c.exists ? `${i + 1}.` : "×"
    const conf = c.confirmedDir === false ? " [目录未确认]" : c.confirmedDir === true ? " [目录已确认]" : ""
    io.print(`  ${flag} ${c.path} — ${c.exists ? "存在" : "不存在(永不创建新文件)"}, ${c.note}${conf}`)
  })
  const selectableCount = candidates.filter((c) => c.exists).length
  if (selectableCount === 0) {
    io.print("无合规目标: 没有已存在的 AGENTS.md 可承载该规则(仅有 CLAUDE.md 或无文件也不回退、不创建)。保持未发布, 不记录批准。")
    return { code: 1 }
  }
  const selRaw = await io.input("选择目标(序号, 逗号分隔多选; 空 = 放弃)", "")
  const sel = parseSelections(selRaw, candidates.length)
  if (!sel || sel.length === 0) {
    io.print("未选择目标 — 放弃批准, 未记录任何决定。")
    return { code: 1 }
  }
  const targets = []
  for (const ix of sel) {
    const c = candidates[ix]
    if (!c || !c.exists) {
      io.print(`拒绝: 所选目标不存在 — 永不创建新文件。`)
      return { code: 1 }
    }
    if (c.kind === "project" && c.confirmedDir !== true) {
      if (!(await io.confirm(`目录 ${c.directory} 未登记确认(projects.json) — 登记并确认该目录?`))) {
        io.print("放弃: 目录未经确认 — 未记录任何决定。")
        return { code: 1 }
      }
    }
    if (c.tracked) {
      if (!(await io.confirm(`${c.path} 被 git 跟踪 — 显式确认发布到被跟踪文件?`))) {
        io.print("放弃: 被跟踪目标未经显式确认 — 未记录任何决定。")
        return { code: 1 }
      }
    }
    targets.push(c.path)
  }
  const directoryBoundary = scope.kind === "directory" ? scope.directory : scope.kind === "project" ? cwd : null

  // ---- build object, hash, fingerprint (stage 2 snapshot) ----
  const object = { body, scope, targets, reviewDate, channel, directoryBoundary, agents: null }
  const objectHash = sha256Hex(canonicalJson(object))
  const ruleIdForFp = rule?.id ?? null
  const issueIdForFp = issue?.id ?? null
  const before = fingerprint(store, ruleIdForFp, issueIdForFp)

  // ---- stage 2: full display ----
  io.print("────────────── 审批对象(段 2/3) ──────────────")
  io.print(`规则: ${rule ? `${rule.id} → 新版本 v${nextVersion}` : "新规则 v1"}${issue ? `(候选 ${issue.id}: ${issue.title})` : ""}`)
  io.print("正文:")
  for (const l of body.split("\n")) io.print(`  | ${l}`)
  io.print(`实际范围: ${describeScope(scope)}`)
  io.print("agent 限制: 无(经 AGENTS.md 发布不区分 agent)")
  io.print(`复查日期: ${reviewDate}`)
  io.print(`通道: ${channel}(补丁由人手工应用; 插件对目标文件零写入)`)
  io.print(`目标(${targets.length}):`)
  for (const t of targets) {
    const c = candidates.find((x) => x.path === t)
    io.print(`  - ${t}`)
    io.print(`    为什么: ${whyTarget(c)}`)
    io.print(`    跟踪: ${c.note} — ${c.tracked ? "已显式确认" : "未跟踪"}`)
  }
  io.print(`对象哈希(确认绑定): ${objectHash.slice(0, 16)}…`)
  io.print("────────────── 等待确认(段 3/3) ──────────────")

  // ---- stage 3: confirm — recompute hash + fingerprint; any change invalidates ----
  if (!(await io.confirm("确认批准以上对象?"))) {
    io.print("已取消 — 未记录任何决定。")
    return { code: 1 }
  }
  const after = fingerprint(store, ruleIdForFp, issueIdForFp)
  const recheckHash = sha256Hex(canonicalJson(object))
  if (recheckHash !== objectHash || !sameFingerprint(before, after)) {
    io.print("确认失效: 段 2 展示与确认时刻的对象/库状态不一致(对象哈希或库指纹已变更 — 可能有并发写入)。")
    io.print("禁止静默重试: 请重新运行 approve, 从段 1 开始重新确认。本次未记录任何决定。")
    return { code: 1 }
  }

  // ---- validate patches BEFORE recording (target-changed → human review).
  // For a brand-new rule the real RUL id is minted by recordDecision below, so
  // validation uses a placeholder id (segment matching is a no-op then) and
  // the printable blocks are regenerated with the real id after recording. ----
  const previous = rule ? { version: rule.version, body: rule.body } : null
  const targetContexts = []
  for (const t of targets) {
    let content = null
    try {
      content = fs.readFileSync(t, "utf8")
    } catch {
      io.print(`拒绝: 目标 ${t} 无法读取 — 目标已变更? 送人审(不推断为用户删除)。未记录任何决定。`)
      return { code: 1 }
    }
    try {
      generatePatch(content, { ruleId: rule?.id ?? "RUL-preview", version: nextVersion, body, previous })
      targetContexts.push({ path: t, candidate: candidates.find((x) => x.path === t), content })
    } catch (e) {
      io.print(`拒绝: 目标 ${t} 补丁生成失败 — ${e.message}`)
      io.print("未记录任何决定; 请先人工核对目标文件。")
      return { code: 1 }
    }
  }

  // ---- record ----
  const { decision, rule: newRule } = store.recordDecision({ kind: "approve", ruleId: rule?.id ?? null, object })
  if (issue) {
    try {
      store.upsertIssue({ id: issue.id, status: "approved" })
    } catch (e) {
      io.print(`警告: 批准已记录(${decision.id}), 但候选状态更新失败: ${e.message}`)
    }
  }
  if (scope.kind === "project") {
    try {
      store.upsertProject({ projectId: scope.projectId, directory: cwd, confirmDirectory: true })
    } catch (e) {
      io.print(`警告: 目录确认登记失败: ${e.message}`)
    }
  }

  // Regenerate with the real rule id (new rules got one just now), then print.
  // formatRulePatch = the shared generate+format composition (step-1a: the
  // prepare_publish tool uses the exact same two calls, so tool and CLI patch
  // text are byte-identical by construction).
  const patches = targetContexts.map((tc) =>
    formatRulePatch({
      targetPath: tc.path,
      why: whyTarget(tc.candidate),
      scopePromise: describeScope(scope),
      trackedNote: tc.candidate.note,
      fileContent: tc.content,
      ruleId: newRule.id,
      version: newRule.version,
      body,
      previous,
    }),
  )

  io.print(`已记录批准: ${decision.id} → 规则 ${newRule.id} v${newRule.version}(对象哈希 ${decision.objectHash.slice(0, 16)}…)`)
  for (const p of patches) io.print(p)
  io.print("════════════════════════════════════════════")
  io.print("批准成功 ≠ 已落地 — 请按上面的补丁手工粘贴到目标文件(插件对目标文件零写入)。")
  io.print("手工应用后, 下次 digest 的只读检查会观察到在场。")
  return { code: 0, patches, ruleId: newRule.id }
}
