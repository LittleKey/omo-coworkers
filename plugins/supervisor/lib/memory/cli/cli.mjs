// bin/supervisor-memory.mjs command implementations (P3 CLI, m1-plan §3 P3).
// Subcommands: init / digest [--draft id] / approve / discard / merge /
// disable / status / doctor. All store mutations go through lib/memory/store.mjs
// transactions; the only files THIS layer writes are rebuildable views under
// <root>/digest/ — never target files, never store state directly.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline/promises"
import {
  SCHEMA_ID,
  SCHEMA_VERSION,
  FILE_RULES,
  FILE_ISSUES,
  FILE_PROJECTS,
  StoreError,
  defaultMemoryRoot,
  initStore,
  openStore,
} from "../store.mjs"
import { parseArgs } from "./args.mjs"
import { readonlyCheck } from "./checks.mjs"
import { generateRemove, formatPatch } from "./patch.mjs"
import { readView, writeView, readDrafts, saveDraft, recordDraftFailure } from "./views.mjs"
import { draftEnv, draftOnce } from "./draft.mjs"
import { runApprove } from "./approve.mjs"

// ---------- IO ----------

export function makeRealIO() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    print: (line = "") => console.log(line),
    confirm: async (prompt) => {
      const a = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase()
      return a === "y" || a === "yes"
    },
    choose: async (prompt, options) => {
      options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`))
      for (;;) {
        const a = (await rl.question(`${prompt} [1-${options.length}] `)).trim()
        const n = Number(a)
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1
        console.log("  无效序号, 请重试。")
      }
    },
    input: async (prompt, def = "") => {
      const a = await rl.question(def !== "" ? `${prompt}(${def}) ` : `${prompt} `)
      return a.trim() === "" ? def : a.trim()
    },
    inputLines: async (prompt) => {
      console.log(`${prompt}: 逐行输入, 单独一行 . 结束:`)
      const lines = []
      for (;;) {
        const l = await rl.question("")
        if (l.trim() === ".") break
        lines.push(l)
      }
      return lines.join("\n")
    },
    close: () => rl.close(),
  }
}

// ---------- errors ----------

export function humanStoreError(e) {
  if (!(e instanceof StoreError)) return e?.message ?? String(e)
  const prefix = `错误[${e.code}]`
  if (e.code === "STORE_MISSING") return `${prefix} 库不存在 — 先运行 init(缺库不是全新安装, 不自动创建)。`
  if (e.code === "STORE_SCHEMA")
    return `${prefix} store schema 版本不匹配。升级路径: 停用旧版本工具 → 备份整个库目录 → 升级 CLI 与 store 后按新版说明迁移; 不要原地混用新旧工具。`
  if (e.code === "STORE_INCOMPLETE")
    return `${prefix} 存在未完成提交 — 授权输出已关闭(不发布/不改状态/不生成补丁)。请按 doctor 的差异报告人工解决(备份还原; v1 无 rebuild)。`
  if (e.code === "STORE_LOCKED") return `${prefix} 库被其他进程锁定, 写入失败且未覆盖。稍后重试; 若持有进程已死, 锁会在宽限期后自动恢复。`
  if (e.code === "STORE_PERM") return `${prefix} 权限问题 — 库目录应为 0700、文件 0600。`
  if (e.code === "STORE_CORRUPT") return `${prefix} 库已损坏, 已拒绝操作(fail-closed)。请从备份还原; 不要手工修补。`
  return `${prefix} ${e.message}`
}

/**
 * Startup schema gate (m1-plan §5 risk table): check the JSON state files'
 * schema/version BEFORE opening, so a future store layout is refused with an
 * upgrade path instead of half-parsed behavior.
 */
export function openStoreChecked(root) {
  for (const f of [FILE_RULES, FILE_ISSUES, FILE_PROJECTS]) {
    let text
    try {
      text = fs.readFileSync(path.join(root, f), "utf8")
    } catch {
      continue
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      continue // unparsable → openStore/doctor reports it properly
    }
    if (doc && typeof doc === "object" && (doc.schema !== SCHEMA_ID || doc.version !== SCHEMA_VERSION)) {
      throw new StoreError(
        "STORE_SCHEMA",
        `${f} 是 ${JSON.stringify(doc.schema)}/${JSON.stringify(doc.version)}, 本工具需要 ${SCHEMA_ID}/${SCHEMA_VERSION}`,
      )
    }
  }
  return openStore(root)
}

// ---------- weekly (D10) ----------

export function isoWeekMonday(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7 // Mon = 0
  d.setDate(d.getDate() - day)
  return d
}

export function isoWeekKey(ts) {
  const d = new Date(ts)
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  thursday.setDate(thursday.getDate() - ((thursday.getDay() + 6) % 7) + 3)
  const jan4 = new Date(thursday.getFullYear(), 0, 4)
  const week1Thu = new Date(jan4)
  week1Thu.setDate(week1Thu.getDate() - ((week1Thu.getDay() + 6) % 7) + 3)
  const week = 1 + Math.round((thursday.getTime() - week1Thu.getTime()) / (7 * 86_400_000))
  return `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`
}

export function weeklyCounts(store, weekStartTs) {
  const weekEndTs = weekStartTs + 7 * 86_400_000
  const inWeek = (t) => typeof t === "number" && t >= weekStartTs && t < weekEndTs
  const issues = store.listIssues()
  const issueById = new Map(issues.map((i) => [i.id, i]))
  const candidates = issues.filter((i) => inWeek(i.createdAtTs)).length
  const dropped = issues.filter((i) => i.status === "dropped" && inWeek(i.updatedAtTs)).length
  const approved = store.listDecisions({ kind: "approve" }).filter((d) => inWeek(d.ts)).length
  const recurrences = store
    .listEvents()
    .filter((e) => inWeek(e.ts) && e.issueId && issueById.get(e.issueId)?.createdAtTs < weekStartTs).length
  return { candidates, approved, dropped, recurrences }
}

const UNKNOWN = "未知"

function weeklySection(store, root, flags, nowTs, { write = true } = {}) {
  const weekStart = flags.week ? parseWeekFlag(flags.week) : isoWeekMonday(nowTs).getTime()
  const key = flags.week ?? isoWeekKey(nowTs)
  const counts = weeklyCounts(store, weekStart)
  const v = readView(root, "weekly.json", { weeks: {} })
  const weeks = v.weeks && typeof v.weeks === "object" ? v.weeks : {}
  const prev = weeks[key] ?? {}
  const prevSr = prev.selfReport ?? {}
  const selfReport = {
    spentMinutes: flags["spent-min"] !== undefined ? flags["spent-min"] : prevSr.spentMinutes ?? null,
    dupBurden: flags["dup-burden"] !== undefined ? flags["dup-burden"] : prevSr.dupBurden ?? null,
    missedExperience: flags["missed-exp"] !== undefined ? flags["missed-exp"] : prevSr.missedExperience ?? null,
    manualIncrement: flags["manual-increment"] !== undefined ? flags["manual-increment"] : prevSr.manualIncrement ?? null,
  }
  if (write) {
    weeks[key] = { week: key, counts, selfReport, updatedAtTs: nowTs }
    writeView(root, "weekly.json", { weeks })
  }
  return { key, counts, selfReport }
}

function parseWeekFlag(w) {
  // "YYYY-Www" → that Monday (local). Fallback: this week.
  const m = /^(\d{4})-W(\d{2})$/.exec(String(w))
  if (!m) return isoWeekMonday(Date.now()).getTime()
  // Jan 4 is always in ISO week 1; walk back from it.
  const jan4 = new Date(Number(m[1]), 0, 4)
  const start = isoWeekMonday(jan4.getTime())
  start.setDate(start.getDate() + (Number(m[2]) - 1) * 7)
  return start.getTime()
}

// ---------- digest rendering ----------

const STATE_LABEL = {
  approved: "已批准(应在场)",
  "awaiting-apply": "待人工应用",
  "readonly-disabled": "已停用(应离场)",
  "readonly-old-version": "旧版本(应离场)",
}
const OBSERVED_LABEL = {
  present: "在场",
  "present-unmarked": "在场(无 marker 包裹)",
  absent: "离场",
  "target-missing": "目标文件缺失",
  "target-changed": "目标已变更",
  "marker-anomaly": "marker 异常",
  "other-version": "存在其他版本段",
}

function printPending(store, pending) {
  console.log(`待审: ${pending.issues.length} 个候选, ${pending.events.length} 个待审事件`)
  for (const iss of pending.issues) {
    console.log(`\n[${iss.id}] ${iss.title} (状态 ${iss.status}, 复发 ${iss.recurrence}, 项目 ${iss.projectId ?? "未知"}, 创建 ${new Date(iss.createdAtTs).toISOString()})`)
    if (iss.topic) console.log(`  主题: ${iss.topic}`)
    const evs = store.listEvents({ issueId: iss.id })
    for (const e of evs) {
      console.log(`  事件 ${e.id} [${e.status}] ${new Date(e.ts).toISOString()} 来源 session=${e.source?.sessionId} project=${e.source?.projectId}`)
      console.log(`    摘录: ${(e.evidence?.excerpt ?? "").replace(/\n/g, " ⏎ ").slice(0, 300)}`)
    }
  }
  const orphans = pending.events.filter((e) => !e.resolvedIssue)
  if (orphans.length > 0) {
    console.log(`\n无归属候选的待审事件: ${orphans.length} 个`)
    for (const e of orphans) console.log(`  ${e.id} ${new Date(e.ts).toISOString()} ${e.evidence?.excerpt?.slice(0, 120) ?? ""}`)
  }
}

function printChecks(checks) {
  if (checks.rows.length === 0) {
    console.log("只读检查: 无已发布记录 — 无可核对目标。")
    return
  }
  console.log(`只读检查(空白规范化比对; 只报告, 不改写, 对目标文件零写入): ${checks.rows.length} 项`)
  for (const r of checks.rows) {
    const ver = r.version === null ? "旧版" : `v${r.version}`
    console.log(`  ${r.ruleId} ${ver} [${STATE_LABEL[r.state] ?? r.state}] ${r.target} → ${OBSERVED_LABEL[r.observed] ?? r.observed}${r.note ? ` (${r.note})` : ""}`)
  }
  for (const r of checks.rows.filter((x) => x.drift)) {
    console.log(`  ⚠ 漂移: ${r.ruleId} 期望在场, 实际 ${OBSERVED_LABEL[r.drift]} — 只报告不改写。`)
  }
  for (const r of checks.rows.filter((x) => x.residue)) {
    console.log(`  ⚠ 残留: ${r.ruleId}(已停用/旧版本)在目标仍可见 — 只报告不改写。`)
  }
  for (const r of checks.reviewNeeded) {
    console.log(`  ⚠ 目标已变更 → 送人审(不推断为用户删除): ${r.target}(${r.ruleId})`)
  }
}

function printWeekly(w) {
  const sr = w.selfReport
  console.log(`\n周报 ${w.key}: 候选 ${w.counts.candidates} / 批准 ${w.counts.approved} / 丢弃 ${w.counts.dropped} / 复发 ${w.counts.recurrences}`)
  console.log(`自报: 处理耗时(分钟) ${sr.spentMinutes ?? UNKNOWN}; 重复负担 ${sr.dupBurden ?? UNKNOWN}; 漏记体验 ${sr.missedExperience ?? UNKNOWN}; 手动整理增量(不靠系统能否想起该候选) ${sr.manualIncrement ?? UNKNOWN}`)
  console.log(`注: 计数与自报字段仅供回顾, 缺失即未知; 计数不单独构成「省事」结论(D10)。`)
}

// ---------- subcommands ----------

export function runInit(root) {
  try {
    const r = initStore(root)
    console.log(`已初始化 memory store: ${r.root}`)
    for (const f of r.files) console.log(`  ${f}`)
    console.log(`  digest/(重建型视图)`)
    return 0
  } catch (e) {
    if (e instanceof StoreError && e.code === "STORE_EXISTS") {
      console.error(`错误: ${e.message}(已存在的库不会被覆盖)。`)
      return 1
    }
    throw e
  }
}

export async function runDigest(ctx, flags) {
  const { store, io } = ctx
  // draft subcommand: explicit, only for the named candidate
  if (flags.draft) {
    const id = flags.draft === true ? ctx.argv?.[0] : flags.draft
    return runDraft(ctx, id, flags)
  }
  const st = store.status()
  const banner = (s) => console.log(`memory store @ ${st.root} — 健康状态: ${s}`)
  banner(st.health.status)
  if (st.health.status === "incomplete_commit") {
    console.log("⚠ 授权关闭: 存在未完成提交 — 以下仅为展示, 不写视图、不产生批准/补丁。")
    const inc = st.incomplete
    if (inc) {
      const landed = inc.files.filter((f) => f.landed).map((f) => f.path)
      const missing = inc.files.filter((f) => !f.landed).map((f) => f.path)
      console.log(`  事务 ${inc.txnId}(${inc.op}): 已落盘 [${landed.join(", ") || "无"}], 未落盘 [${missing.join(", ") || "无"}]`)
    }
  } else if (st.health.status !== "ok") {
    for (const p of st.health.problems) console.log(`  问题[${p.severity}] ${p.detail}`)
    console.log("(完整诊断见 doctor)")
  }
  try {
    printPending(store, store.listPending())
    const checks = readonlyCheck(store.listRules(), store.listDecisions())
    printChecks(checks)
    const w = weeklySection(store, store.root, flags, Date.now(), { write: st.health.status === "ok" })
    printWeekly(w)
    // views only on a healthy store (rebuildable, non-authoritative)
    if (st.health.status === "ok") {
      writeView(store.root, "pending.json", { ts: Date.now(), ...store.listPending() })
      writeView(store.root, "checks.json", { ts: Date.now(), ...checks })
    } else {
      console.log("(视图未写: 健康状态非 ok)")
    }
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
  io.print("")
  return 0
}

export async function runDraft(ctx, id, flags) {
  const { store, io, env } = ctx
  if (typeof id !== "string" || id.length === 0) {
    io.print("用法: supervisor-memory digest --draft <issueId>")
    return 1
  }
  let issue
  try {
    issue = store.getIssue(id)
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
  if (!issue) {
    io.print(`未找到候选 ${id}。`)
    return 1
  }
  if (issue.status !== "draft") {
    io.print(`拒绝: 候选 ${id} 状态为 ${issue.status}; 仅为 draft 候选起草。`)
    return 1
  }
  const denv = draftEnv(env ?? {})
  if (!denv.apiKey) {
    io.print("未设置 SUPERVISOR_MEMORY_DRAFT_API_KEY — 跳过起草(未发送任何网络请求)。请人工起草。")
    return 0
  }
  const events = store.listEvents({ issueId: id })
  io.print(`起草 ${id}: 外发范围仅该候选的 ${events.length} 条事件与摘录(不含全库); 模型 ${denv.model} @ ${denv.baseUrl}; 单次尝试。`)
  const r = await draftOnce({ issue, events, env: denv, fetchImpl: ctx.fetchImpl, timeoutMs: ctx.draftTimeoutMs ?? 30_000 })
  if (r.status === "ok") {
    io.print("── 草稿正文 ──")
    io.print(r.text)
    io.print("── 结束 ──")
    const wantStore = flags["store-draft"] === true || (io.isTTY && (await io.confirm("存为该候选的草稿?")))
    if (wantStore) {
      saveDraft(store.root, id, r.text, Date.now())
      io.print(`已存入 ${path.join(store.root, "digest/drafts.json")}(重建型视图, 非授权状态)。`)
    }
    return 0
  }
  if (r.status === "no-key") {
    io.print("未设置 SUPERVISOR_MEMORY_DRAFT_API_KEY — 跳过起草。请人工起草。")
    return 0
  }
  recordDraftFailure(store.root, id, r.error, Date.now())
  const failures = readDrafts(store.root).failures[id]?.count ?? 1
  io.print(`起草失败(${r.status === "timeout" ? "超时" : r.error}) — 请人工起草; 不重试, 不影响普通 digest。该候选累计失败 ${failures} 次。`)
  return 0
}

export function runDiscard(ctx, id) {
  const { store, io } = ctx
  if (typeof id !== "string" || id.length === 0) {
    io.print("用法: supervisor-memory discard <issueId|eventId>")
    return 1
  }
  try {
    if (id.startsWith("EVT-")) {
      store.confirmEvent(id, "false_positive")
      io.print(`事件 ${id} 已标记误报(终态; 原始来源保留)。`)
    } else {
      const iss = store.getIssue(id)
      if (!iss) {
        io.print(`未找到候选 ${id}。`)
        return 1
      }
      if (iss.status !== "draft") {
        io.print(`候选 ${id} 已是终态(${iss.status}) — 丢弃不可重复; 重新上报同一事实只会重复计数, 不恢复授权。`)
        return 1
      }
      store.upsertIssue({ id, status: "dropped" })
      io.print(`候选 ${id} 已丢弃(终态; 重新上报同一事实只会重复计数, 不恢复授权)。`)
    }
    return 0
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

export function runMerge(ctx, donorId, targetId) {
  const { store, io } = ctx
  if (typeof donorId !== "string" || typeof targetId !== "string") {
    io.print("用法: supervisor-memory merge <donorIssueId> <targetIssueId>")
    return 1
  }
  try {
    store.mergeIssues(donorId, targetId)
    io.print(`已合并: ${donorId} → ${targetId}。双方事件的原始来源保留; 合并不连带授权、不扩大范围; 请对 ${targetId} 单独审批。`)
    return 0
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

export function runDisable(ctx, ruleId) {
  const { store, io } = ctx
  if (typeof ruleId !== "string" || ruleId.length === 0) {
    io.print("用法: supervisor-memory disable <ruleId>")
    return 1
  }
  try {
    store.requireHealthy()
    const rule = store.getRule(ruleId)
    if (!rule) {
      io.print(`未找到规则 ${ruleId}。`)
      return 1
    }
    if (rule.status !== "active") {
      io.print(`拒绝: 规则 ${ruleId} 当前状态 ${rule.status}; 仅 active 规则可停用。`)
      return 1
    }
    store.recordDecision({ kind: "disable", ruleId })
    io.print(`已停用 ${ruleId}(人的决定; 库中状态 disabled, 保留 targets)。`)
    io.print("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
    io.print("!! 库中停用 ≠ 文件残留已撤回 — 若补丁曾被手工应用, 目标文件中的受管段落仍在, 请用下面的移除补丁手工删除。")
    io.print("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")
    if ((rule.targets ?? []).length === 0) {
      io.print("(该规则无已登记目标 — 从未发布, 无移除补丁。)")
    }
    for (const t of rule.targets ?? []) {
      let content
      try {
        content = fs.readFileSync(t, "utf8")
      } catch {
        io.print(`  目标 ${t}: 文件缺失(可能已删除; 无可移除内容)。`)
        continue
      }
      try {
        const patches = generateRemove(content, { ruleId })
        if (!patches) {
          io.print(`  目标 ${t}: 未发现该规则的受管段(未应用过或已移除)。`)
          continue
        }
        for (const p of patches) {
          io.print(formatPatch({ targetPath: t, why: "已停用规则的已知发布目标", scopePromise: "移除整个受管段(所有版本)", tracked: p.notes?.join("; ") || "见文件", patch: p }))
        }
      } catch (e) {
        io.print(`  目标 ${t}: marker 异常, fail-closed — ${e.message}(送人审, 不推断为用户删除)。`)
      }
    }
    return 0
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

export function runStatus(ctx) {
  try {
    const st = ctx.store.status()
    console.log(`memory store @ ${st.root}`)
    console.log(`健康状态: ${st.health.status}`)
    for (const p of st.health.problems) console.log(`  问题[${p.severity}] ${p.detail}`)
    if (st.incomplete) {
      const landed = st.incomplete.files.filter((f) => f.landed).map((f) => f.path)
      const missing = st.incomplete.files.filter((f) => !f.landed).map((f) => f.path)
      console.log(`未完成提交 ${st.incomplete.txnId}(${st.incomplete.op}): 已落盘 [${landed.join(", ") || "无"}], 未落盘 [${missing.join(", ") || "无"}]`)
    }
    console.log(`锁: ${st.lock?.exists ? `${st.lock.state}${st.lock.pid !== null ? `(pid ${st.lock.pid})` : ""}` : "无持有者"}`)
    console.log(`计数: 规则 ${JSON.stringify(st.counts.rules)}; 候选 ${JSON.stringify(st.counts.issues)}; 事件 ${JSON.stringify(st.counts.events)}; 决定 ${JSON.stringify(st.counts.decisions)}; 项目 ${JSON.stringify(st.counts.projects)}`)
    return ["ok", "incomplete_commit"].includes(st.health.status) ? 0 : 1
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
}

export function runDoctor(ctx) {
  const d = ctx.store.doctor()
  console.log(`doctor @ ${d.root} — 健康状态: ${d.health.status}`)
  for (const c of d.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
  if (d.health.status === "ok") {
    console.log("结论: 健康。")
    return 0
  }
  console.log("结论: 不健康 — 授权输出保持关闭; 请按以上差异人工处理(备份还原; v1 无 rebuild)。")
  return 1
}

// ---------- usage / main ----------

export function printUsage() {
  console.log(`supervisor-memory — 人审 CLI(P3)与精确补丁输出(P4)

用法: supervisor-memory [--root <store目录>] <子命令> [参数]

子命令:
  init                     显式初始化库(缺库不是全新安装; 已存在则拒绝覆盖)
  digest                   待审列表 + 来源摘录 + 只读检查(D9) + 周报(D10)
  digest --draft <issueId> 仅为该候选起草一次(外发仅该候选事件摘录; 需
                           SUPERVISOR_MEMORY_DRAFT_API_KEY, 失败不重试)
  approve <ISS-|RUL->      三段式 TTY 审批(D6); 输出手工应用补丁; 批准 ≠ 已落地
  discard <ISS-|EVT->      丢弃候选 / 标记事件误报(终态)
  merge <donor> <target>   合并候选(双方事件原始来源保留; 不连带授权)
  disable <RUL->           停用规则 + 输出已知目标的移除补丁(库中停用 ≠ 残留已撤回)
  status                   库状态人读呈现
  doctor                   只读诊断(含未完成提交差异报告)

选项:
  --root <dir>             库根目录(默认 ~/.local/share/opencode-supervisor/memory)
  --week YYYY-Www          周报目标周
  --spent-min <n>          周报自报: 处理耗时(分钟)
  --dup-burden <text>      周报自报: 重复负担
  --missed-exp <text>      周报自报: 漏记体验
  --manual-increment <text> 周报自报: 手动整理增量
  --store-draft            非交互时保存 --draft 草稿
环境变量(digest --draft):
  SUPERVISOR_MEMORY_DRAFT_API_KEY / SUPERVISOR_MEMORY_DRAFT_BASE_URL
  (默认 http://10.126.126.10:3000/v1) / SUPERVISOR_MEMORY_DRAFT_MODEL(默认 glm-5.3)`)
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {object} opts {env, cwd, home, io, fetchImpl, draftTimeoutMs}
 * @returns {Promise<number>} exit code
 */
export async function main(argv, opts = {}) {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const home = opts.home ?? os.homedir()
  const { flags, pos } = parseArgs(argv)
  const cmd = pos[0] ?? "help"
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage()
    return 0
  }
  const root = typeof flags.root === "string" ? flags.root : defaultMemoryRoot()
  if (cmd === "init") {
    try {
      return runInit(root)
    } catch (e) {
      console.error(humanStoreError(e))
      return 1
    }
  }
  let store
  try {
    store = openStoreChecked(root)
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  }
  const io = opts.io ?? makeRealIO()
  const ctx = { store, io, cwd, home, env, argv: pos.slice(1), fetchImpl: opts.fetchImpl, draftTimeoutMs: opts.draftTimeoutMs }
  try {
    switch (cmd) {
      case "digest":
        return await runDigest(ctx, flags)
      case "approve":
        return (await runApprove(ctx, pos[1])).code
      case "discard":
        return runDiscard(ctx, pos[1])
      case "merge":
        return runMerge(ctx, pos[1], pos[2])
      case "disable":
        return runDisable(ctx, pos[1])
      case "status":
        return runStatus(ctx)
      case "doctor":
        return runDoctor(ctx)
      default:
        console.error(`未知子命令: ${cmd}(见 supervisor-memory help)`)
        return 2
    }
  } catch (e) {
    console.error(humanStoreError(e))
    return 1
  } finally {
    if (typeof io.close === "function") io.close()
  }
}
