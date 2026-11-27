import { connectHost } from "./vendor/host.js"
import { request, roleIntent, hasChanges, usablePreview, changeSummary } from "./model.js"
const $ = id => document.getElementById(id)
const el = (tag,text,cls) => { const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n }
const btn = (text,fn,cls) => { const n=el("button",text,cls);n.type="button";n.onclick=fn;return n }
let host,snapshot,catalog={catalog:[],variants:{}},contributions,selected,draft,preview,writing=false,reading=false,pendingLeave
let generation=0
let draftBaseline=null
const current=()=>snapshot?.capabilities.find(c=>c.id===selected)
const dirty=()=>hasChanges(draftBaseline,draft)
const titleOf=c=>({"document-role":"文档协作","lark-role":"飞书操作","collaboration":"协作指导","claude-acp-guidance":"Claude 指导","antigravity-acp-guidance":"Antigravity 指导"})[c.id]||c.title
const call=(method,path,body)=>request(host,method,path,body)
function notice(text,error=false){$("notice").textContent=text;$("notice").dataset.error=String(error)}
function showError(e){notice(`${e.code || "未完成"} · ${e.message} ${e.nextAction || "请核对设置后重试。"}${e.code==="CONFLICT"?" 草稿已保留；读取最新状态后重新核对。":""}`,true)}
async function action(fn){if(writing)return;writing=true;lock();try{await fn()}catch(e){showError(e)}finally{writing=false;lock()}}
function lock(){
  for(const n of document.querySelectorAll("[data-write]"))n.disabled=writing
  const detail=$("detail");detail.inert=writing
  $("list").inert=writing
  document.querySelector(".support").inert=writing
  $("leave").inert=writing
  $("stay").disabled=$("discard-leave").disabled=writing
  $("commit").disabled=writing||!usablePreview(preview)||(preview?.changes.some(c=>c.risk)&&!$("risk-check")?.checked)
  $("refresh").disabled=reading||writing
  $("cancel-preview").disabled=writing
  if($("risk-check"))$("risk-check").disabled=writing
}
function invalidate(){preview=null;$("confirmation").hidden=true}
function navigate(id){
  if(writing)return
  if(dirty()){pendingLeave=id;$("leave").hidden=false;$("stay").focus();return}
  open(id)
}
function open(id){
  if(writing)return
  generation++
  renderOpen(id)
}
function renderOpen(id,preserveDraft=false){
  invalidate();selected=id
  const c=current()
  if(!preserveDraft){
    draftBaseline=c?.settings?structuredClone(c):null
    draft=c?.settings?{enabled:c.settings.enabled,model:c.settings.model.value,variant:c.settings.variant.value,variantChosen:false}:null
  }
  $("workspace").dataset.open=String(Boolean(c));renderList();renderDetail()
  if(c)$("detail-title").focus();else document.querySelector("#list button")?.focus()
}
$("stay").onclick=()=>{if(writing)return;$("leave").hidden=true;$("detail-title")?.focus()}
$("discard-leave").onclick=()=>{if(writing)return;$("leave").hidden=true;open(pendingLeave)}
function renderList(){
  $("list").replaceChildren()
  for(const kind of ["role","guidance"]){
    $("list").append(el("p",kind==="role"?"项目角色":"项目指导","group-label"))
    for(const c of snapshot.capabilities.filter(c=>c.kind===kind)){
      const b=btn("",()=>navigate(c.id));b.dataset.id=c.id;b.setAttribute("aria-current",String(c.id===selected))
      b.append(el("strong",titleOf(c)),el("span",c.kind==="role"?(c.settings?`${c.settings.enabled?"配置启用":"配置停用"} · 运行中未确认`:"配置不可用 · 请查看诊断"):"项目内容 · 不提供代理启停","badge"))
      if(c.settings)b.append(el("span",c.settings.model.value||c.settings.model.inheritedValue||"模型来源待确认","model-full"))
      $("list").append(b)
    }
  }
}
function change(){generation++;invalidate();renderSave()}
function renderDetail(){
  const box=$("detail");box.replaceChildren();const c=current()
  if(!c){box.append(el("p","选择一项能力，查看项目内容与可用设置。","empty"));return}
  const back=btn("← 返回能力",()=>navigate(null));back.id="back";box.append(back)
  const title=el("h2",titleOf(c));title.id="detail-title";title.tabIndex=-1;box.append(title)
  box.append(el("p",c.kind==="role"?"只调整启用、模型与支持的思考等级。项目正文与依赖不在这里编辑。":"采用项目指导，不等于启停内建代理或外部 ACP 服务。","muted"))
  if(c.kind==="role"&&!c.settings)box.append(el("p","配置暂不可用。下方环境诊断与恢复入口仍可使用；修复后刷新。","muted"))
  if(c.settings){
    const label=el("label",undefined,"check"),check=el("input");check.type="checkbox";check.id="enabled";check.checked=draft.enabled
    check.onchange=()=>{draft.enabled=check.checked;change()};label.append(check,el("span","启用此角色（配置）"));box.append(label)
    modelControls(box,c)
  }
  const content=el("section",undefined,"card")
  content.append(el("h3","项目标准内容"),el("p",({matching:"与当前项目内容匹配",available:"尚可采用项目标准",different:"与现有内容不同；不会自动接管",blocked:"暂不能安全更新"})[c.contentStatus]||"内容状态未知"))
  content.append(el("p","仅处理声明的项目内容；保留模型设置、个人额外 Skills/MCP 与凭据。正文差异仅提供哈希摘要，不展示秘密或全文。","muted"))
  if(c.contentStatus!=="matching"){
    const approve=el("label",undefined,"check"),input=el("input");input.type="checkbox";input.id="adopt-confirm"
    approve.append(input,el("span","我选择采用项目标准，并允许替换已识别的内联项目覆盖。"));content.append(approve)
    const adopt=btn(c.contentStatus==="different"?"查看项目内容更新":"采用项目标准",()=>action(async()=>{
      if(dirty())throw new Error("请先保存或取消角色设置，再采用项目内容。")
      if(!input.checked)throw new Error("请明确确认采用范围；当前内容尚未改动。")
      await previewIntent({kind:"adopt-content",capabilityId:c.id,confirmInlineReplacement:true})
    }));adopt.dataset.write="";if(c.contentStatus==="blocked"){adopt.disabled=true;delete adopt.dataset.write;content.append(el("p","请查看下方诊断，处理后重新读取。","muted"))}content.append(adopt)
  }
  const deps=el("details");deps.append(el("summary","包含内容与依赖"))
  deps.append(el("p","提示词、路由与声明的依赖由项目维护；分配依赖不代表授予全部权限。","muted"))
  const dl=el("dl")
  for(const [label,values] of [["必需依赖",c.dependencies.required],["可选依赖",c.dependencies.optional]])dl.append(el("dt",label),el("dd",values.length?values.join("、"):"未声明"))
  dl.append(el("dt","依赖就绪状态"),el("dd","未确认；缺少工具或凭据请在宿主配置，不在此安装。"));deps.append(dl);content.append(deps);box.append(content)
  const save=el("div");save.id="save";box.append(save);renderSave()
}
function modelControls(box,c){
  const model=c.settings.model,variant=c.settings.variant
  const label=el("label","模型");label.htmlFor="model";box.append(label)
  const select=el("select");select.id="model";select.disabled=!model.editable||!variant.editable
  const values=[...new Set([draft.model,...catalog.catalog].filter(Boolean))]
  if(!draft.model){const o=el("option","保留当前来源（不能在此设置继承）");o.value="";select.append(o)}
  for(const value of values){const o=el("option",value+(catalog.catalog.includes(value)?"":" · 当前值，目录未确认"));o.value=value;select.append(o)}
  select.value=draft.model||""
  select.onchange=()=>{draft.model=select.value;draft.variantChosen=false;draft.variant=variant.value;change();renderVariant()}
  box.append(select,el("p",model.reason||(!variant.editable?"思考等级来源只读，暂不能安全切换模型。":`来源：${model.source}`),"source"))
  const full=el("p",draft.model||model.inheritedValue||"未解析模型","model-full");select.addEventListener("change",()=>full.textContent=draft.model);box.append(full)
  box.append(el("p","目录来自宿主 CLI，未验证是否对应当前宿主实例；不代表模型能成功调用。","muted"))
  if(catalog.diagnostics?.length)box.append(el("p",`目录诊断：${catalog.diagnostics.join("、")}。当前未知值会保留，不猜测模型或等级。`,"muted"))
  const region=el("div");box.append(region)
  function renderVariant(){
    region.replaceChildren()
    const label=el("label","思考等级");label.htmlFor="variant";region.append(label)
    const input=el("select");input.id="variant";input.disabled=!model.editable||!variant.editable
    const changed=draft.model!==model.value
    const keep=el("option",changed?"请选择：更换模型需要明确等级":"保留当前设置");keep.value="keep";input.append(keep)
    const def=el("option",`默认 / 删除覆盖${variant.inheritedValue?`（可能继承 ${variant.inheritedValue}）`:""}`);def.value="default";input.append(def)
    for(const v of catalog.variants[draft.model]||[]){const o=el("option",v);o.value=`id:${v}`;input.append(o)}
    input.value=draft.variantChosen?(draft.variant===null?"default":`id:${draft.variant}`):"keep"
    input.onchange=()=>{draft.variantChosen=input.value!=="keep";draft.variant=input.value==="default"?null:input.value.startsWith("id:")?input.value.slice(3):variant.value;change()}
    region.append(input,el("p",`当前：${variant.value??"默认"}；来源：${variant.source}${variant.reason?`；${variant.reason}`:""}`,"source"))
    if(!model.editable)region.append(el("p",model.reason||"模型来源只读，因此思考等级也不可修改。","muted"))
    if(!(catalog.variants[draft.model]||[]).length)region.append(el("p","没有可确认的等级目录；只可保留当前值或明确选择默认，不猜测 low/high。","muted"))
  }renderVariant()
}
function renderSave(){
  const box=$("save");if(!box)return;box.replaceChildren();box.className=dirty()?"save":""
  if(!dirty())return
  box.append(el("p","有未保存设置 · 不会改写项目提示词或 Skills","muted"))
  const actions=el("div",undefined,"actions")
  const save=btn("保存设置",()=>action(async()=>{
    if(!current()?.settings)throw new Error("配置暂不可用；草稿保留，请修复配置后刷新。")
    await previewIntent(roleIntent(current(),draft))
  }))
  if(current()?.settings)save.dataset.write=""
  else {save.disabled=true;box.append(el("p","配置暂不可用，保存已暂停；草稿仍保留。修复配置后刷新并重新核对。","muted"))}
  actions.append(btn("取消修改",()=>open(selected)),save);box.append(actions)
}
async function previewIntent(intent){
  const owner=selected,epoch=generation
  const result=await call("POST","/intent-preview",{revision:snapshot.revision,intent})
  if(owner!==selected||epoch!==generation){notice("设置已变化，旧预览已丢弃。请重新保存。");return}
  showPreview(result)
}
function showPreview(result){
  preview=result;$("confirmation").hidden=false;$("summary").replaceChildren()
  for(const c of result.changes){
    const text=changeSummary(c)
    $("summary").append(el("p",`${c.field?.join(".")||c.resourceId}：${text}`,"source"))
  }
  for(const w of result.warnings||[])$("summary").append(el("p",w,"muted"))
  $("expiry").textContent=`预览有效至 ${result.expiresAt}`
  $("risk").replaceChildren()
  if(result.changes.some(c=>c.risk)){const label=el("label",undefined,"check"),check=el("input");check.type="checkbox";check.id="risk-check";check.onchange=lock;label.append(check,el("span","确认本次列出的风险修改。"));$("risk").append(label)}
  $("confirm-title").focus();lock()
}
$("cancel-preview").onclick=()=>{invalidate();$("detail-title")?.focus()}
$("commit").onclick=()=>action(async()=>{
  if(!usablePreview(preview))throw new Error("预览已失效，请重新保存。")
  const risk=preview.changes.some(c=>c.risk);if(risk&&!$("risk-check")?.checked)throw new Error("请确认本次风险。")
  const owner=selected,epoch=generation
  await call("PATCH","/config",{previewId:preview.previewId,...(risk?{confirmRisk:true}:{})})
  if(owner!==selected||epoch!==generation){invalidate();notice("已提交旧预览；当前草稿保留，请重新读取核对。");return}
  invalidate()
  if(current()?.settings)draft={enabled:current().settings.enabled,model:current().settings.model.value,variant:current().settings.variant.value,variantChosen:false}
  await refresh(false);notice("已保存到磁盘 · 运行中未确认。需要时通过宿主 UI 重载。")
})
async function refresh(preserve=true){
  reading=true;lock()
  try{
    const [snapshotResult,modelResult]=await Promise.allSettled([call("GET","/snapshot"),call("GET","/models")])
    if(modelResult.status==="fulfilled")catalog=modelResult.value
    else catalog={...catalog,diagnostics:["目录读取失败，可刷新重试"]}
    if(snapshotResult.status!=="fulfilled")throw snapshotResult.reason
    const next=snapshotResult.value,wasDirty=dirty()
    snapshot=next;renderSupport();generation++;renderOpen(selected,preserve&&wasDirty)
    if(preserve&&wasDirty)notice("已读取最新状态，草稿保留；请重新核对后保存。")
  }finally{reading=false;lock()}
}
function requireClean(){if(dirty())throw new Error("请先保存或取消当前能力设置，再执行此操作。")}
function renderSupport(){
  $("diagnostics").replaceChildren(...snapshot.diagnostics.map(d=>el("p",`${d.code} · ${d.reason} ${d.nextAction}`,"muted")))
  $("history").replaceChildren(...snapshot.history.map(h=>{
    const b=btn(`预览撤销 · ${h.summary}`,()=>action(async()=>{requireClean();showPreview(await call("POST","/undo-preview",{transactionId:h.id}))}));b.disabled=!h.undoable;return b
  }))
  $("recovery").replaceChildren()
  if(snapshot.diagnostics.some(d=>/RECOVERY|PENDING/.test(d.code)))$("recovery").append(btn("恢复中断写入",()=>action(async()=>{requireClean();await call("POST","/recover",{confirm:true});await refresh();notice("恢复请求完成；请核对最新诊断。")})))
  if(snapshot.diagnostics.some(d=>/MIGRATION/.test(d.code))){
    const stopped=el("input"),discard=el("input");stopped.type=discard.type="checkbox"
    const a=el("label",undefined,"check"),b=el("label",undefined,"check")
    a.append(stopped,el("span","旧版本服务与写入流程已停止。"))
    b.append(discard,el("span","我明确放弃旧模板收据的长期撤回能力；旧文件保留。"))
    $("recovery").append(el("p","迁移不是自动操作；旧的中断写入需先恢复。","muted"),a,b,btn("查看旧状态迁移",()=>action(async()=>{
      requireClean()
      if(!stopped.checked)throw new Error("请先停止旧写入流程。")
      showPreview(await call("POST","/migration-preview",{confirmOldWriterStopped:true,...(discard.checked?{confirmDiscardReceipts:true}:{})}))
    })))
  }
}
function renderGuard(){
  const s=contributions.settings,box=$("guard");box.replaceChildren();const details=el("details");details.append(el("summary","Claude guard · 独立行为设置"),el("p",`${s.claudeGuardEnabled?"已开启":"已关闭"} · 运行中未确认。独立 claude-advisor 副本可见性未知，未报告重复不代表不存在。`,"muted"))
  const check=el("input");check.type="checkbox";const label=el("label",undefined,"check");label.append(check,el("span","本次开启会改变工具派发，我已核对重复副本风险。"));if(!s.claudeGuardEnabled)details.append(label)
  details.append(btn(s.claudeGuardEnabled?"关闭 guard":"开启 guard",()=>action(async()=>{requireClean();if(!s.claudeGuardEnabled&&!check.checked)throw new Error("请确认本次行为变化与重复风险。");await call("PATCH","/settings",{revision:s.revision,claudeGuardEnabled:!s.claudeGuardEnabled,...(!s.claudeGuardEnabled?{confirmEnable:true}:{})});contributions=await call("GET","/contributions");renderGuard();notice("行为设置已保存，需按需重载；不属于配置撤销记录。")})));box.append(details)
}
$("refresh").onclick=()=>refresh().catch(showError)
window.addEventListener("beforeunload",e=>{if(dirty()){e.preventDefault();e.returnValue=""}})
setInterval(lock,15000)
try{host=connectHost();await Promise.all([
  refresh().catch(showError),
  call("GET","/contributions").then(data=>{contributions=data;renderGuard()}).catch(showError),
])}catch(e){showError(e)}
