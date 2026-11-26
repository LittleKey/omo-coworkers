import { connectHost } from "./vendor/host.js"
import { VERSION, VERSIONS, ACKNOWLEDGMENTS, confirmations, request, usablePreview } from "./model.js"

const $ = id => document.getElementById(id)
const host = connectHost()
let status = null, preview = null, busy = false
const stateLabels = { "not-applied":"尚未应用", "applied-pending-restart":"已写入，待重启", "rolled-back-pending-restart":"已回滚，待重启", "recovery-required":"需要恢复；禁止继续应用", blocked:"已阻止，请处理冲突" }
function text(tag, value, className) {
  const node = document.createElement(tag)
  node.textContent = String(value)
  if (className) node.className = className
  return node
}
for (const [key, label] of ACKNOWLEDGMENTS) {
  const row = text("label", "", "check"), input = document.createElement("input")
  input.type = "checkbox"; input.id = key; input.setAttribute("aria-label", label)
  row.append(input, text("span", label)); $("checks").append(row)
}
for (const [key, value] of Object.entries(VERSIONS)) {
  const row = text("label", `${key} · 支持 ${value}`), input = document.createElement("input")
  input.type = "text"; input.id = `version-${key}`; input.autocomplete = "off"; input.placeholder = "填写实际版本"
  input.setAttribute("aria-label", `${key} 实际版本，支持 ${value}`)
  row.append(input); $("versions").append(row)
}
function consent() {
  return confirmations(Object.fromEntries(ACKNOWLEDGMENTS.map(([key]) => [key, $(key).checked])),
    Object.fromEntries(Object.keys(VERSIONS).map(key => [key, $(`version-${key}`).value.trim()])))
}
function controls() {
  const ready = !busy && status && consent()
  $("preview").disabled = !ready || ["blocked", "recovery-required"].includes(status?.state)
  $("rollback-preview").disabled = !ready || ["not-applied", "blocked", "recovery-required"].includes(status?.state)
  $("recovery-section").hidden = status?.state !== "recovery-required"
  $("recover").disabled = !ready || status?.state !== "recovery-required" || !$("recovery-check").checked
  $("proceed").disabled = busy || !usablePreview(preview) || !$("proceed-check").checked
  $("refresh").disabled = busy; $("cancel").disabled = busy
  for (const input of $("confirmations").querySelectorAll("input")) input.disabled = busy
}
function invalidate() { preview = null; $("preview-section").hidden = true; $("proceed-check").checked = false; controls() }
function notice(message, error = false) { $("notice").textContent = message; $("notice").dataset.error = String(error) }
function renderStatus() {
  $("status").replaceChildren()
  const drift = status?.diskDrift ?? status?.drift
  const entries = [
    ["已安装扩展", status?.installedVersion ?? VERSION],
    ["随包内容版本", status?.contentVersion ?? "尚未取得"],
    ["随包清单哈希", status?.manifestHash ?? "尚未取得"],
    ["候选配置根", status?.candidateRoot ?? "尚未取得；不能写入"],
    ["写入状态", stateLabels[status?.state] ?? "未知；请刷新"],
    ["已应用版本", status?.appliedContentVersion ?? status?.appliedVersion ?? (status?.snapshotStale ? "待刷新" : "尚无记录")],
    ["已应用内容哈希", status?.appliedContentHash ?? status?.appliedHash ?? (status?.snapshotStale ? "待刷新" : "尚无记录")],
    ["磁盘漂移", drift === false ? "未发现漂移" : drift === true ? "存在漂移；需重新核对" : "未检查 / 未提供"],
    ["重启状态", status?.pendingRestart === true || status?.state?.endsWith("-pending-restart") ? "待通过宿主 UI 手动重启/重载" : "无待重启记录；不代表已验证运行时"],
    ["运行时", "未验证（环境与版本确认仅为用户声明）"],
  ]
  for (const [key, value] of entries) $("status").append(text("dt", key), text("dd", value))
}
function writeResult(result) {
  // A write invalidates the previous read-only snapshot; never show stale hashes as current.
  status = { ...status, state: result.state, snapshotStale: true, appliedContentVersion: null, appliedContentHash: null,
    appliedVersion: null, appliedHash: null, drift: null, diskDrift: null,
    pendingRestart: result.state?.endsWith("-pending-restart") === true }
  renderStatus()
}
async function run(action) {
  if (busy) return
  busy = true; controls(); notice("正在处理…")
  try { await action() }
  catch (error) {
    invalidate()
    $("recovery-check").checked = false
    const code = error.code || "CONNECTION_ERROR"
    notice(`${code}：${error.message}。未确认完成；不要假定已全部写入。请刷新状态，处理漂移/锁或恢复冲突后重新预览。若服务未获授权，请在设置 → 扩展中检查。`, true)
  } finally { busy = false; controls() }
}
async function refresh() {
  for (const [key] of ACKNOWLEDGMENTS) $(key).checked = false
  $("recovery-check").checked = false
  invalidate(); status = null; renderStatus()
  status = await request(host, "/status"); renderStatus()
}
async function prepare(kind) {
  const confirmed = consent()
  if (!confirmed) return
  await run(async () => {
    invalidate()
    const next = await request(host, kind === "apply" ? "/preview" : "/rollback-preview", { confirmations: confirmed })
    if (!usablePreview(next) || next.kind !== kind || !Array.isArray(next.changes)) throw new Error("预览响应无效，请刷新重试")
    preview = next
    $("preview-title").textContent = kind === "apply" ? "2 · 审阅应用摘要" : "2 · 审阅条件回滚摘要"
    $("expiry").textContent = `预览有效至 ${new Date(next.expiresAt).toLocaleString()}；磁盘变化或服务重启后须重新预览。`
    $("warnings").replaceChildren(...(next.warnings || []).map(w => text("li", w)))
    $("changes").replaceChildren(...next.changes.map(change => {
      const row = text("article", "", "change")
      row.append(text("strong", `${({create:"新增",update:"更新",delete:"删除"})[change.action] ?? change.action} · ${change.path}`),
        text("p", `之前 ${change.beforeHash ?? "不存在"}`, "hash"), text("p", `之后 ${change.afterHash ?? "不存在"}`, "hash"))
      return row
    }))
    if (!next.changes.length) $("changes").append(text("p", "没有待写入的内容变化。"))
    $("proceed").textContent = kind === "apply" ? "确认应用" : "确认回滚"
    $("preview-section").hidden = false
    $("preview-title").focus()
    notice("预览未写入文件。回滚仅在当前内容仍符合记录时允许；冲突会阻止操作。")
  })
}
$("confirmations").addEventListener("change", invalidate)
$("confirmations").addEventListener("input", invalidate)
$("confirmations").addEventListener("submit", event => { event.preventDefault(); if (!$("preview").disabled) prepare("apply") })
$("rollback-preview").addEventListener("click", () => prepare("rollback"))
$("proceed-check").addEventListener("change", controls)
$("cancel").addEventListener("click", () => { invalidate(); notice("预览已取消；未发出写入请求。") })
$("recover").addEventListener("click", () => {
  const confirmed = consent()
  if (!confirmed || status?.state !== "recovery-required" || !$("recovery-check").checked) return
  run(async () => {
    invalidate()
    const result = await request(host, "/recover", { confirmations: confirmed })
    $("recovery-check").checked = false
    for (const [key] of ACKNOWLEDGMENTS) $(key).checked = false
    writeResult(result)
    notice("恢复请求已完成；未应用新载荷，运行时未验证。请刷新状态后重新核对并预览。")
  })
})
$("refresh").addEventListener("click", () => run(async () => { await refresh(); notice("状态已刷新。运行时仍未验证。") }))
$("proceed").addEventListener("click", () => {
  if (!usablePreview(preview) || !$("proceed-check").checked) { invalidate(); notice("预览已过期，请重新预览。", true); return }
  const selected = preview
  run(async () => {
    invalidate()
    const result = await request(host, selected.kind === "apply" ? "/apply" : "/rollback", { previewId: selected.previewId })
    // Clear all acknowledgments after every write; subsequent operations require fresh consent.
    for (const [key] of ACKNOWLEDGMENTS) $(key).checked = false
    writeResult(result)
    notice("写入已完成，待通过宿主 UI 手动重启/重载。运行时尚未验证。请刷新以读取最新版本、内容哈希和漂移状态。")
  })
})
setInterval(controls, 1000)
host.onReady(() => run(async () => { await refresh(); notice("请核对候选根及运行环境，再生成预览。") }))
renderStatus(); controls()
