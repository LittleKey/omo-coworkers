import { connectHost } from "./vendor/host.js"
import { VERSION, request, fieldKey, fieldControl, parseValue, safeOperations, usablePreview, assertDraftCompatible } from "./model.js"

const $ = id => document.getElementById(id)
const node = (tag, text, className) => {
  const el = document.createElement(tag)
  if (text !== undefined) el.textContent = text
  if (className) el.className = className
  return el
}
const button = (text, action, className) => {
  const el = node("button", text, className); el.type = "button"; el.onclick = action; return el
}
const json = value => value === undefined ? "（不存在）" : JSON.stringify(value, null, 2)
let host, snapshot, templateData, contributionData, currentResource, preview, busy = false, savedThisSession = false
const drafts = new Map(), invalid = new Set(), revealed = new Map(), selection = new Map()

function notice(text, error = false) {
  $("notice").textContent = text; $("notice").dataset.error = String(error)
  if (error) { $("notice").tabIndex = -1; $("notice").focus(); $("notice").scrollIntoView({ block: "nearest" }) }
}
function errorNotice(error) {
  const fields = error.conflicts?.map(c => `${c.resourceId} / ${c.field?.join(".") || "全文"}`).join("、")
  notice(`${error.code || "REQUEST_FAILED"} · ${error.message}${fields ? ` 冲突字段：${fields}。` : ""} ${error.nextAction || "检查本次修改后重试。"}${error.code === "CONFLICT" ? " 可重新读取，草稿会保留；核对后再次预览。" : ""}`, true)
}
async function run(action) {
  if (busy) return
  busy = true
  // One interaction lock for every async request, including preview and commit.
  // Keep original disabled states; never enable a read-only control on release.
  const locked = [...document.querySelectorAll("input, textarea, select")]
    .map(el => [el, el.disabled])
  for (const [el] of locked) el.disabled = true
  document.querySelector("main").inert = true
  controls()
  try { await action() } catch (error) { errorNotice(error) }
  finally {
    for (const [el, wasDisabled] of locked) el.disabled = wasDisabled
    document.querySelector("main").inert = false
    busy = false; controls()
  }
}
const call = (method, path, body) => {
  assertDraftCompatible(method, path, drafts.size > 0 || invalid.size > 0)
  return request(host, method, path, body)
}
function invalidatePreview() { preview = null; $("preview-section").hidden = true }
function controls() {
  const blocked = !snapshot || !host || busy
  $("refresh").disabled = busy || !host
  $("preview").disabled = blocked || !drafts.size || invalid.size > 0 || drafts.size > 32
  $("discard").disabled = busy || !drafts.size && !invalid.size
  $("draft-status").textContent = drafts.size || invalid.size ? `${drafts.size} 项未保存修改${invalid.size ? ` · ${invalid.size} 项输入需修正` : ""}` : "没有未保存修改"
  $("save-reason").textContent = busy ? "正在处理，请稍候。" : !snapshot ? "尚未读到配置；请检查服务权限后重新读取。" : invalid.size ? "有输入格式不正确，请修正对应字段。" : drafts.size > 32 ? "每次最多保存 32 项，请减少本次修改。" : drafts.size ? "先查看真实内容差异，再保存到磁盘。重新读取会保留草稿。" : "选择普通字段编辑；受保护值不可查看或替换。"
  const risk = preview?.changes.some(c => c.risk)
  $("proceed").disabled = busy || !usablePreview(preview) || (risk && !$("risk-check")?.checked)
  $("proceed-reason").textContent = !usablePreview(preview) ? "预览已失效，请重新预览。" : risk && !$("risk-check")?.checked ? "本次涉及删除、执行或权限修改，请确认下方列出的风险。" : "仅保存本次差量；不会重启宿主。"
  for (const el of document.querySelectorAll("[data-network]")) el.disabled = busy
}
function networkButton(text, action) { const el = button(text, () => run(action)); el.dataset.network = ""; return el }
function diagnostic(d) {
  const box = node("div", undefined, "diagnostic")
  box.append(node("strong", d.code || "提示"), node("p", d.reason || ""), node("p", d.nextAction || "", "muted"))
  return box
}
function renderStatus() {
  $("status").replaceChildren()
  const config = snapshot.resources.find(r => r.kind === "config")
  for (const [label, value] of [
    ["逻辑路径", config?.logicalPath || "未提供"], ["实际目标", config?.actualPath || "未提供"],
    ["运行中配置", "未确认 · 项目或环境可能覆盖"],
    ["保存状态", savedThisSession ? "本会话已保存 · 重载未确认" : "磁盘快照"],
  ]) $("status").append(node("dt", label), node("dd", value))
  $("diagnostics").replaceChildren(...(snapshot.diagnostics || []).filter(d => !["RUNTIME_UNCONFIRMED", "CUSTOM_ROOT_UNAVAILABLE"].includes(d.code)).map(diagnostic))
  const scope = node("details", undefined, "scope-note")
  scope.append(node("summary", "默认候选目录 · 自定义根暂不支持"), node("p", "若实际实例使用其他目录，请在其原生配置入口编辑。服务中的 HOME/XDG 仅决定此磁盘候选，不能证明运行中实例使用它。这里不会向任意路径写入。", "muted"), node("p", `随包面板 ${VERSION}；${snapshot.capabilities?.differentialEdit ? "服务支持局部字段编辑与受保护结构" : "编辑能力以服务诊断为准"}。保存状态仅记录本面板会话操作，不是独立检测的运行中状态。`, "muted"))
  $("diagnostics").append(scope)
}
function stage(resource, field, action, value) {
  const key = fieldKey(resource.id, field.path)
  invalid.delete(key)
  if (action === "set" && JSON.stringify(value) === JSON.stringify(field.value)) drafts.delete(key)
  else drafts.set(key, { resourceId: resource.id, field: field.path, action, ...(action === "set" ? { value } : {}) })
  invalidatePreview(); controls()
}
function renderField(resource, sourceField) {
  const key = fieldKey(resource.id, sourceField.path)
  const field = revealed.has(key) ? { ...sourceField, value: revealed.get(key), editable: true } : sourceField
  const box = node("div", undefined, "field")
  const heading = node("div", undefined, "field-heading")
  const label = node("label", field.path.join(".") || "提示词全文")
  const id = `field-${resource.fields.indexOf(sourceField)}`
  label.htmlFor = id; heading.append(label); box.append(heading)
  if (field.classification === "protected") {
    box.append(node("div", "受保护 · 原值保留在服务端", "protected")); return box
  }
  if (field.classification === "prompt" && !revealed.has(key)) {
    box.append(node("p", "提示词默认不传到面板。仅在需要查看或编辑时打开；请勿在提示词中存放秘密。", "muted"))
    const reveal = networkButton("查看并编辑这段提示词", async () => {
      const result = await call("POST", "/reveal", { resourceId: resource.id, revision: resource.revision, field: field.path, confirm: true })
      revealed.set(key, result.value); renderEditor(); notice(result.warning || "提示词已按本次明确操作打开；不要添加秘密。")
    })
    box.append(reveal); return box
  }
  if (!resource.writable || !field.editable) {
    box.append(node("pre", json(field.value), "protected"), node("p", "此字段当前只读。请查看上方该资源的诊断和处理建议。", "muted")); return box
  }
  const draft = drafts.get(key)
  const value = draft?.action === "set" ? draft.value : field.value
  const control = fieldControl(field.path)
  let input
  if (control?.type === "select") {
    input = node("select")
    for (const optionValue of control.options) {
      const option = node("option", optionValue); option.value = optionValue; input.append(option)
    }
    input.value = value
  } else if (typeof value === "boolean") {
    input = node("select"); for (const v of [true, false]) { const option = node("option", v ? "true · 开启" : "false · 关闭"); option.value = String(v); input.append(option) }
    input.value = String(value)
  } else {
    input = node(typeof value === "object" || field.classification === "prompt" || String(value).length > 120 ? "textarea" : "input")
    if (input.tagName === "INPUT") input.type = "text"
    input.value = typeof value === "string" ? value : json(value)
    if (typeof value !== "string") input.className = "code"
  }
  if (control?.type === "number") {
    input.type = "number"; input.min = control.min; input.max = control.max; input.step = control.step
  }
  input.id = id; input.setAttribute("aria-label", `${resource.id} ${field.path.join(".") || "提示词全文"}`)
  const message = node("span", draft?.action === "delete" ? "已标记删除；保存前需确认。" : "", "muted")
  input.oninput = () => {
    try {
      if (control?.type === "number" && (!input.value || !input.checkValidity())) throw new Error("INVALID_VALUE")
      stage(resource, field, "set", parseValue(input.value, field.value))
      input.removeAttribute("aria-invalid"); message.textContent = "已加入本地草稿。"
    } catch {
      invalid.add(key); input.setAttribute("aria-invalid", "true"); message.textContent = control?.type === "number" ? "timeoutMs 需要 0–2147483647 的整数（毫秒）；0 表示不设超时。" : "需要有效 JSON 值；数组请使用 [ … ]。"
      invalidatePreview(); controls()
    }
  }
  box.append(input, message)
  const actions = node("div", undefined, "actions")
  actions.append(button("删除此字段", () => { stage(resource, field, "delete"); message.textContent = "已标记删除；保存前需确认。" }))
  if (field.classification === "ordinary" && !field.path.some(k => ["command", "args", "cwd", "env", "headers"].includes(k))) {
    const pickLabel = node("label", undefined, "check"), pick = node("input"); pick.type = "checkbox"; pick.checked = selection.has(key)
    pick.setAttribute("aria-label", `将 ${field.path.join(".")} 选入用户模板`)
    pick.onchange = () => { if (pick.checked) selection.set(key, { resourceId: resource.id, field: field.path }); else selection.delete(key) }
    pickLabel.append(pick, node("span", "选入我的模板")); actions.append(pickLabel)
  } else if (field.classification === "ordinary") {
    actions.append(node("span", "执行或机器专属字段不保存为用户模板。", "muted"))
  }
  box.append(actions); return box
}
function renderEditor() {
  const resource = snapshot.resources.find(r => r.id === currentResource) || snapshot.resources[0]
  currentResource = resource?.id
  $("resources").replaceChildren(...snapshot.resources.map(r => {
    const el = button(r.kind === "config" ? "OMO 全局配置" : r.logicalPath, () => { currentResource = r.id; renderEditor() })
    el.setAttribute("aria-current", String(r.id === currentResource)); return el
  }))
  $("editor").replaceChildren()
  if (!resource) { $("editor").append(node("p", "未发现可显示的配置资源。请查看诊断。", "empty")); return }
  $("editor").append(node("p", `${resource.logicalPath} → ${resource.actualPath}`, "muted"))
  const groups = new Map()
  for (const field of resource.fields) {
    const group = field.path[0] || "提示词"
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(field)
  }
  const names = { agents: "Agents · 模型与角色", models: "Models · 模型", presets: "Presets · 预设与继承", preset: "当前预设", acp: "ACP · 执行与指导", acpAgents: "ACP · 执行与指导", default_agent: "默认 Agent" }
  for (const [group, fields] of groups) {
    const section = node("section", undefined, "field-group"); section.append(node("h3", names[group] || group))
    for (const field of fields) section.append(renderField(resource, field))
    $("editor").append(section)
  }
  if (resource.kind === "config") {
    {
    const common = node("details", undefined, "field-group")
    common.append(node("summary", "新增 Agent / ACP · 创建或复制预设"))
    const kind = node("select"); kind.setAttribute("aria-label", "新增配置类型")
    for (const [value, title] of [["agent","Agent 模型"],["acp","ACP 命令"],["preset","预设中的 Agent 模型"],["copy","复制预设的普通字段"]]) {
      const option = node("option", title); option.value = value; kind.append(option)
    }
    const name = node("input"); name.setAttribute("aria-label", "新 Agent ACP 或预设名称"); name.placeholder = "名称，例如 team"
    const agent = node("input"); agent.setAttribute("aria-label", "预设 Agent 或复制源预设"); agent.placeholder = "预设中的 Agent 名称 / 要复制的源预设"
    const value = node("input"); value.setAttribute("aria-label", "模型或 ACP 命令"); value.placeholder = "provider/model 或可执行命令"
    common.append(kind, name, agent, value, button("加入常用配置草稿", () => {
      try {
        if (!resource.writable) throw new Error("此资源只读，请先处理诊断。")
        const key = name.value.trim(), member = agent.value.trim()
        if (!/^[a-zA-Z0-9_-]+$/.test(key) || ["__proto__","constructor","prototype"].includes(key)) throw new Error("名称请使用字母、数字、短横线或下划线。")
        let operations
        if (kind.value === "copy") {
          const source = resource.fields.filter(f => f.path[0] === "presets" && f.path[1] === member)
          operations = source.filter(f => f.classification === "ordinary" && f.editable).map(f => ({resourceId:resource.id, field:["presets",key,...f.path.slice(2)],action:"set",value:f.value}))
          if (!source.length || !operations.length) throw new Error("源预设没有可复制的普通字段。请选择已有预设。")
          if (source.length !== operations.length) notice("仅复制普通字段；受保护值和未打开的提示词不会复制。")
        } else {
          if (!value.value.trim()) throw new Error("请填写模型或命令。")
          if (kind.value === "preset" && !/^[a-zA-Z0-9_-]+$/.test(member)) throw new Error("请填写预设中的 Agent 名称。")
          const field = kind.value === "agent" ? ["agents",key,"model"] : kind.value === "acp" ? ["acpAgents",key,"command"] : ["presets",key,"agents",member,"model"]
          operations = [{resourceId:resource.id,field,action:"set",value:value.value.trim()}]
        }
        for (const op of safeOperations(operations)) drafts.set(fieldKey(resource.id,op.field),op)
        invalidatePreview(); controls()
      } catch (error) { notice(error.message,true) }
    }), node("p", "只加入局部字段；已有值的变化会出现在差异中。创建预设后，在 preset 字段选择它。复制不会带入受保护字段或提示词。", "muted"))
    $("editor").append(common)
    }
    const advanced = node("details", undefined, "field-group")
    advanced.append(node("summary", "高级 · 完整受保护结构与新增字段"), node("p", "这不是原始 JSONC：秘密与未知文本仅显示占位，注释留在服务端。只能提交单个字段修改，不能回写整个投影。", "muted"), node("pre", json(resource.projection), "projection"))
    const form = node("div", undefined, "subsection")
    const path = node("input"); path.placeholder = '["agents", "my-agent", "model"]'; path.setAttribute("aria-label", "新字段路径 JSON 数组")
    const value = node("textarea"); value.placeholder = '"provider/model"'; value.setAttribute("aria-label", "新字段 JSON 值")
    form.append(node("label", "字段路径（JSON 字符串数组）"), path, node("label", "字段值（JSON）"), value)
    const add = button("加入草稿", () => {
      try {
        const parts = JSON.parse(path.value), parsed = JSON.parse(value.value)
        const op = safeOperations([{ resourceId: resource.id, field: parts, action: "set", value: parsed }])[0]
        if (!parts.length) throw new Error("不能覆盖整份配置。")
        drafts.set(fieldKey(resource.id, parts), op); invalidatePreview(); controls(); notice("新字段已加入草稿；服务会验证字段是否允许编辑。")
      } catch (error) { notice(error.message, true) }
    })
    add.disabled = !resource.writable
    form.append(add, node("p", resource.writable ? "模型、preset 继承、skills、MCP 分配等按原生字段定义填写。命令与权限修改会在预览后单独确认。" : "该资源只读；请先处理上方诊断。", "muted"))
    advanced.append(form); $("editor").append(advanced)
  }
}
function renderPreview(result) {
  preview = { ...result, receivedAt: Date.now() }
  $("preview-section").hidden = false
  $("expiry").textContent = `服务端有效期至：${preview.expiresAt || "未提供（不可保存）"}；一次保存后失效。`
  $("warnings").replaceChildren(...(preview.warnings || []).map(w => node("p", w, "warning")))
  $("changes").replaceChildren(...preview.changes.map(c => {
    const box = node("div", undefined, "change")
    box.append(node("h3", `${c.resourceId} / ${c.field.join(".") || "提示词全文"}${c.risk ? ` · ${c.risk}` : ""}`))
    const diff = node("div", undefined, "diff")
    const hashOnly = (!Object.hasOwn(c,"before") && c.beforeExists !== false) || (!Object.hasOwn(c,"after") && c.afterExists !== false)
    if (hashOnly) box.append(node("p","部分内容未揭露，仅显示受保护摘要，不是完整内容差异；未返回原文不代表内容不存在。","warning"))
    for (const [name, value, cls] of [["修改前", c.before, "before"], ["修改后", c.after, "after"]]) {
      const half = node("div", undefined, cls), hashValue = cls === "before" ? c.beforeHash : c.afterHash
      const exists = c[`${cls}Exists`]
      half.append(node("p", name, "muted"), node("pre", exists === false ? "无此值" : Object.hasOwn(c,cls) ? json(value) : `内容未揭露 · SHA256 ${hashValue ?? "未提供"}`)); diff.append(half)
    }
    box.append(diff); return box
  }))
  $("risk-confirmation").replaceChildren()
  if (preview.changes.some(c => c.risk)) {
    const label = node("label", undefined, "check"), check = node("input"); check.type = "checkbox"; check.id = "risk-check"; check.onchange = controls
    label.append(check, node("span", "我确认本次列出的删除、执行命令或权限修改；仅对本次变更生效。")); $("risk-confirmation").append(label)
  }
  controls(); $("preview-title").focus()
}
function templateParameters(template, container) {
  const inputs = new Map()
  const params = Array.isArray(template.parameters) ? template.parameters : Object.entries(template.parameters || {}).map(([name, spec]) => ({ name, ...(typeof spec === "object" ? spec : { description: String(spec) }) }))
  for (const spec of params) {
    const name = spec.name || spec.id || spec.key
    if (!name) continue
    if (spec.type === "array" && Array.isArray(spec.choices)) {
      const group = node("fieldset"); group.append(node("legend", spec.label || name))
      const picks = []
      for (const choice of spec.choices) {
        const label = node("label", undefined, "check"), input = node("input")
        input.type = "checkbox"; input.value = choice; input.checked = spec.default?.includes(choice) || false
        input.setAttribute("aria-label", `${template.id} ${choice}`)
        label.append(input, node("span", choice)); group.append(label); picks.push(input)
      }
      container.append(group); inputs.set(name, { get value() { return picks.filter(el => el.checked).map(el => el.value) } }); continue
    }
    const label = node("label", spec.description || spec.label || name, "field"), input = node("input")
    input.type = "text"; input.setAttribute("aria-label", `${template.id} ${name}`); input.value = spec.default === undefined ? "" : String(spec.default)
    label.append(input); container.append(label); inputs.set(name, input)
  }
  return () => Object.fromEntries([...inputs].filter(([, el]) => el.value !== "").map(([key, el]) => [key, el.value]))
}
function renderTemplates() {
  $("templates").replaceChildren(); $("user-templates").replaceChildren()
  for (const t of [...(templateData.templates || []), ...(templateData.userTemplates || [])]) {
    const card = node("article", undefined, "card")
    card.append(node("h3", t.name || t.title || t.id), node("p", t.description || ""), node("span", "配方 · 不建立所有权", "badge"))
    if (t.dependencies?.length) card.append(node("p", `所选依赖：${t.dependencies.map(d => typeof d === "string" ? d : `${d.agent} · ${d.code}`).join("、")}`, "muted"))
    const params = templateParameters(t, card)
    const actions = node("div", undefined, "actions")
    const replacements = node("div"), chosen = new Map()
    const previewTemplate = async () => {
      if (drafts.size || invalid.size) { notice("请先保存或放弃当前草稿，再选择模板。", true); return }
      try {
        renderPreview(await call("POST", "/template-preview", { revision: snapshot.revision, templateId: t.id, parameters: params(), ...(chosen.size ? { replace: [...chosen.values()] } : {}) }))
      } catch (error) {
        if (error.code === "NO_CHANGES") { invalidatePreview(); notice("所选配方与现有内容匹配，无需修改；不会建立模板所有权。"); return }
        if (error.code === "CONFLICT" && error.conflicts?.length) {
          replacements.replaceChildren(node("p", "以下个人值不同，默认保留。仅勾选你愿意替换的具体字段，再查看差异；不会自动替换其他值。", "warning")); chosen.clear()
          for (const c of error.conflicts) {
            if (typeof c.resourceId !== "string" || !Array.isArray(c.field)) continue
            const label = node("label", undefined, "check"), input = node("input")
            input.type = "checkbox"
            const identity = { resourceId: c.resourceId, field: c.field }
            input.onchange = () => { const key = fieldKey(c.resourceId,c.field); if (input.checked) chosen.set(key, identity); else chosen.delete(key) }
            label.append(input, node("span", `替换 ${c.resourceId} / ${c.field.join(".") || "提示词全文"}`)); replacements.append(label)
          }
        }
        throw error
      }
    }
    actions.append(networkButton("选择并查看差异", previewTemplate))
    actions.append(networkButton("复制为我的模板", async () => {
      const id = $("template-id").value.trim(), description = $("template-description").value.trim()
      if (!id) { notice("请先在下方填写我的模板标识。", true); return }
      renderPreview(await call("POST", "/user-templates", { revision: snapshot.revision, id, description, copyTemplateId: t.id, parameters: params() }))
    }))
    card.append(replacements, actions)
    ;(templateData.userTemplates?.includes(t) ? $("user-templates") : $("templates")).append(card)
    if (templateData.userTemplates?.includes(t)) card.append(networkButton("预览删除此用户模板", async () => renderPreview(await call("DELETE", "/user-templates", { revision: snapshot.revision, id: t.id }))))
  }
  $("template-create").replaceChildren()
  const id = node("input"); id.id = "template-id"; id.placeholder = "my-team"; id.setAttribute("aria-label", "用户模板标识")
  const description = node("input"); description.id = "template-description"; description.placeholder = "用途说明"; description.setAttribute("aria-label", "用户模板说明")
  $("template-create").append(node("label", "模板标识"), id, node("label", "说明"), description, networkButton("从选中配置项保存模板", async () => {
    if (!id.value.trim() || !selection.size) { notice("填写模板标识，并在配置页选择普通字段。", true); return }
    renderPreview(await call("POST", "/user-templates", { revision: snapshot.revision, id: id.value.trim(), description: description.value.trim(), selection: [...selection.values()] }))
  }))
}
async function loadTemplates() { templateData = await call("GET", "/templates"); renderTemplates() }
function renderContributions() {
  const box = $("contributions"); box.replaceChildren()
  const inventory = node("div", undefined, "cards")
  for (const [title, detail] of [
    ["omo-coworkers", "随包声明的原生插件入口。宿主是否已将它贡献到当前实例，仍需在宿主扩展页核对。"],
    ["随包 Skills", "文档维护、领域建模与 humanizer 通过原生贡献声明提供；不是模板或外部 ACP 程序。"],
  ]) { const card = node("article", undefined, "card"); card.append(node("h3", title), node("p", detail), node("span", "运行中加载未确认", "badge")); inventory.append(card) }
  box.append(inventory)
  const metadata = node("details")
  metadata.append(node("summary", "查看服务报告的贡献与行为状态"), node("pre", json(contributionData.contributions), "projection")); box.append(metadata)
  for (const d of contributionData.diagnostics || []) box.append(diagnostic(d))
  const settings = contributionData.settings || {}
  const card = node("div", undefined, "card")
  card.append(node("h3", "Claude guard"), node("p", settings.claudeGuardEnabled ? "设置：开启（运行中未确认）" : "设置：关闭"), node("p", `设置来源：${settings.source || "未提供"}。独立 claude-advisor 的可见性可能不完整；未报告重复不代表没有重复。`, "muted"))
  const enableLabel = node("label", undefined, "check"), enable = node("input")
  enable.type = "checkbox"; enable.id = "guard-confirm"
  enableLabel.append(enable, node("span", "仅本次开启：我已了解 guard 会改变工具派发，并核对独立 claude-advisor 的重复风险。"))
  if (!settings.claudeGuardEnabled) card.append(enableLabel)
  const save = networkButton(settings.claudeGuardEnabled ? "关闭 guard" : "开启 guard", async () => {
    if (!settings.claudeGuardEnabled && !enable.checked) { notice("开启前请确认本次行为变化与重复风险。", true); return }
    await call("PATCH", "/settings", { revision: settings.revision, claudeGuardEnabled: !settings.claudeGuardEnabled, ...(!settings.claudeGuardEnabled ? { confirmEnable: true } : {}) })
    contributionData = await call("GET", "/contributions"); renderContributions(); notice("行为设置已保存，需通过宿主重载。运行中未确认；此设置不在配置撤销记录内。")
  })
  card.append(save, node("p", "旧 writer transform 不由管理器开启。行为设置独立保存，不属于下方配置事务的撤销或恢复；保存不会自动重载。", "muted")); box.append(card)
}
function renderHistory() {
  $("history").replaceChildren()
  for (const h of snapshot.history || []) {
    const card = node("div", undefined, "card"); card.append(node("h3", h.summary), node("p", h.createdAt, "muted"))
    const undo = networkButton("预览撤销本次修改", async () => {
      renderPreview(await call("POST", "/undo-preview", { transactionId: h.id }))
    })
    undo.disabled = !h.undoable
    if (!h.undoable) { delete undo.dataset.network; card.append(node("p", "此记录当前不可撤销。请重新读取并查看冲突或容量诊断。", "muted")) }
    card.append(undo); $("history").append(card)
  }
  if (!snapshot.history?.length) $("history").append(node("p", "暂无配置变更记录。", "empty"))
  $("recovery").replaceChildren()
  $("migration").replaceChildren()
  const migration = node("details", undefined, "subsection")
  migration.append(node("summary", "显式迁移旧管理状态"), node("p", "仅在有旧状态时使用。启动与读取不会迁移。旧文件保留，新格式一旦建立便是唯一权威；不能再运行旧版本写入。旧的未完成事务必须先恢复。", "muted"))
  const stopped = node("input"), discard = node("input")
  stopped.type = discard.type = "checkbox"
  const stoppedLabel = node("label", undefined, "check"), discardLabel = node("label", undefined, "check")
  stoppedLabel.append(stopped,node("span","旧版本服务与写入流程已停止。"))
  discardLabel.append(discard,node("span","如果存在旧模板收据，我明确放弃其长期升级、永久移除及恢复首次应用前状态的能力；改用配方与最近十次撤销。"))
  migration.append(stoppedLabel,discardLabel,networkButton("预览旧状态迁移",async()=>{
    if (!stopped.checked) { notice("请先停止旧服务与写入流程，再确认此项。",true); return }
    renderPreview(await call("POST","/migration-preview",{confirmOldWriterStopped:true,...(discard.checked?{confirmDiscardReceipts:true}:{})}))
  }))
  $("migration").append(migration)
  if (snapshot.diagnostics?.some(d => /RECOVERY|JOURNAL/.test(d.code))) {
    $("recovery").append(node("h3", "恢复未完成的写入"), node("p", "此操作会按日志有条件地还原中断事务，不能强制覆盖冲突。"))
    $("recovery").append(networkButton("恢复中断事务（写入磁盘）", async () => { await call("POST", "/recover", { confirm: true }); savedThisSession = true; await refresh(); notice("恢复请求完成。请检查最新诊断；运行中仍未确认。") }))
  }
}
async function refresh() {
  const next = await call("GET", "/snapshot")
  snapshot = next; revealed.clear(); invalidatePreview()
  renderStatus(); renderEditor(); renderHistory(); controls()
}
document.querySelectorAll("[data-view]").forEach(tab => tab.onclick = () => {
  document.querySelectorAll("[data-view]").forEach(el => { if (el === tab) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current") })
  document.querySelectorAll(".view").forEach(el => { el.hidden = el.id !== `view-${tab.dataset.view}` })
})
$("refresh").onclick = () => run(async () => { await refresh(); notice(drafts.size ? "已重新读取；本地草稿保留。请核对新值后重新预览。" : "已读取磁盘配置；运行中状态未确认。") })
$("discard").onclick = () => { drafts.clear(); invalid.clear(); invalidatePreview(); renderEditor(); controls(); notice("已放弃本地草稿，未写入磁盘。") }
$("preview").onclick = () => run(async () => renderPreview(await call("POST", "/preview", { revision: snapshot.revision, operations: safeOperations([...drafts.values()]) })))
$("cancel").onclick = () => { invalidatePreview(); controls() }
$("proceed").onclick = () => run(async () => {
  if (!usablePreview(preview)) throw new Error("预览已失效，请重新预览。")
  const risk = preview.changes.some(c => c.risk)
  if (risk && !$("risk-check")?.checked) throw new Error("请确认本次风险修改。")
  await call("PATCH", "/config", { previewId: preview.previewId, ...(risk ? { confirmRisk: true } : {}) })
  savedThisSession = true; drafts.clear(); invalid.clear(); await refresh(); await loadTemplates(); notice("本次差异已提交到磁盘；运行中未确认。原生配置有变化时，请按需通过宿主 UI 重载。")
})
setInterval(controls, 15000)
try {
  host = await connectHost()
  await run(async () => {
    await refresh()
    await Promise.all([
      loadTemplates().catch(error => { $("templates").replaceChildren(diagnostic({ code: error.code, reason: error.message, nextAction: error.nextAction })) }),
      call("GET", "/contributions").then(result => { contributionData = result; renderContributions() }).catch(error => { $("contributions").replaceChildren(diagnostic({ code: error.code, reason: error.message, nextAction: error.nextAction })) }),
    ])
  })
} catch { notice("无法连接宿主。请在 OpenChamber 的扩展面板打开，并检查本地服务授权。", true); controls() }
