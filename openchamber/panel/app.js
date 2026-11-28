import { connectHost } from "./vendor/host.js"
import { applyHostReady } from "./vendor/theme.js"
import { request, ids, locked, acp, clone, equal, modelId, differences, createDraftQueue, usablePreview, parseBackup, catalogPath } from "./model.js"
import { createDiagnostics } from "./diagnostics.js"

const $=id=>document.getElementById(id)
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
const button=(text,fn,cls)=>{const b=el("button",text,cls);b.type="button";b.onclick=fn;return b}
const note=text=>el("small",text)
const check=(text,value,fn,disabled=false)=>{const l=el("label",undefined,"check"),i=el("input");i.type="checkbox";i.checked=value;i.disabled=disabled;i.onchange=()=>fn(i.checked);l.append(i,document.createTextNode(text));return l}
const trace=createDiagnostics()
let host,snapshot,queue,selected="orchestrator",tab="roles",catalog={models:[],status:"waiting"},catalogEpoch=0,refreshing=false
let preview=null,operation=null,operationBusy=false,previewBusy=false,logs=false,logTimer,applied=null,contextDirectory,contextEpoch=0
const operationStorageKey="omo-workbench-pending-operation-v4"
const memory=()=>queue.state.memory
const call=(method,path,body)=>request({serviceRequest:input=>logs?trace.serviceRequest(host,input):host.serviceRequest(input)},method,path,body)
function banner(text,actions=[]){const box=$("banner");box.replaceChildren();box.hidden=!text;if(text)box.append(document.createTextNode(text));for(const [label,fn]of actions)box.append(button(label,fn))}
function error(e){banner(`${e.code||"未完成"} · ${e.message}${e.field?` · 字段：${e.field}`:""}${e.resource?` · 资源：${e.resource}`:""} ${e.nextAction||""}`)}
function openDialog(id){const d=$(id);d.returnFocus=document.activeElement;d.showModal()}
for(const id of ["picker","review","data-dialog","import-dialog"])$(id).addEventListener("close",()=>$(id).returnFocus?.focus())
function showData(title,text,confirm){
  $("data-title").textContent=title;$("data-text").textContent=text
   $("data-confirm").hidden=!confirm;$("data-confirm").onclick=()=>{$("data-dialog").close();return confirm?.()}
  openDialog("data-dialog")
}
function stateChanged(){
  renderFooter()
  if(queue.state.phase==="conflict")banner("草稿已被另一页面修改。本页编辑仍保留；请备份后选择读取最新草稿。",[
    ["备份本页编辑",exportMemory],
    ["放弃本页编辑并读取最新",()=>showData("读取最新草稿","将丢弃本页尚未保存的编辑和无效输入，不覆盖服务器草稿。",async()=>{try{const next=await call("GET","/workbench");queue.acceptLatest(next);snapshot=next;banner("");render()}catch(e){error(e)}})]
  ])
  renderList()
}
function edit(path,value){queue.edit(path,value)}
function resetRole(id){
  const r=memory().roles[id],rec=snapshot.recommendations.roles[id]
  for(const key of acp(id)?["wrapperModel","requestedVariant"]:["model","variant"]){if(rec[key]===undefined)delete r[key];else r[key]=rec[key]}
}
function differsRecommendation(id){const r=memory().roles[id],rec=snapshot.recommendations.roles[id];return (acp(id)?["wrapperModel","requestedVariant"]:["model","variant"]).some(k=>!equal(r[k],rec?.[k]))}
function renderList(){
  if(!queue)return
  const list=$("list");list.replaceChildren()
  for(const id of ids.filter(id=>id.includes($("role-search").value.toLowerCase()))){
    const role=memory().roles[id],model=role.model||role.wrapperModel
    const b=button("",()=>{selected=id;$("app").dataset.open="true";renderList();renderDetail();$("role-title").focus()})
    b.setAttribute("aria-current",String(selected===id));b.dataset.role=id
    const line=el("span",undefined,"roleline");line.append(el("span",id))
    const tags=[];if(locked(id))tags.push(["🔒","不可停用"]);if(acp(id))tags.push(["ACP","ACP 代理"]);if(!role.enabled)tags.push(["停","已停用"])
    if(model&&!catalog.models.some(m=>modelId(m)===model))tags.push(["!","目录中未确认"])
    if(memory().recommendationsEnabled&&differsRecommendation(id))tags.push(["•","已改"])
    const badge=el("span",tags.map(t=>t[0]).join(" "),"badge");badge.setAttribute("aria-label",tags.map(t=>t[1]).join("，"))
    line.append(badge);b.append(line,note(model||"未选模型"));list.append(b)
  }
}
function renderDetail(){
  if(!queue)return
  const id=selected,r=memory().roles[id],box=$("detail");box.replaceChildren()
  box.append(button("‹ 角色",()=>{$("app").dataset.open="false";$("role-search").focus()},"back"))
  const heading=el("div",undefined,"heading"),title=el("h1",id);title.id="role-title";title.tabIndex=-1;heading.append(title)
  heading.append(locked(id)?el("span","🔒 不可停用","badge"):check("启用",r.enabled,v=>{edit(["roles",id,"enabled"],v);if(id==="observer"&&v)banner("请确认 observer 所选模型支持视觉。")}))
  box.append(heading)
  const row=el("div",undefined,"row");row.append(el("h2",acp(id)?"包装层模型":"模型"))
  if(memory().recommendationsEnabled&&differsRecommendation(id))row.append(button("恢复推荐",()=>{resetRole(id);queue.changed();renderDetail()}))
  box.append(row)
  const model=r.model||r.wrapperModel,choose=button(model||"选择模型",()=>{$("search").value="";renderOptions();openDialog("picker");$("search").focus()},"model");choose.id="choose";box.append(choose)
  if(model&&!catalog.models.some(m=>modelId(m)===model))box.append(note("! 目录中未确认 · 当前引用保留"))
  if(acp(id)){
    box.append(note("内部模型：由外部代理运行时决定"),note(`包装层思考等级意向：${r.requestedVariant||"默认"} · 原生 ACP 不支持该字段，仅保存意向，不写入运行配置。`))
    renderConnection(box,id,r)
  }else{
    box.append(el("div","思考等级","row"))
    const available=catalog.models.find(m=>modelId(m)===model)?.variants||[]
    const values=[...new Set(["",...available,...(r.variant?[r.variant]:[])])]
    const label=v=>v?(v+(!available.includes(v)?" ?":"")):"默认"
    if(values.length<=4){const segments=el("div",undefined,"segments");for(const v of values){const b=button(label(v),()=>{edit(["roles",id,"variant"],v||undefined);renderDetail()});b.setAttribute("aria-pressed",String(v===(r.variant||"")));segments.append(b)}box.append(segments)}
    else {const select=el("select");select.setAttribute("aria-label","思考等级");for(const v of values){const o=el("option",label(v));o.value=v;select.append(o)}select.value=r.variant||"";select.onchange=()=>edit(["roles",id,"variant"],select.value||undefined);box.append(select)}
  }
  if(["council","councillor"].includes(id))box.append(note("council 席位与预设保持原样，只读；councillor 的通用模型不会覆盖各席位模型。"))
  if(id==="claude"){
    const d=el("details");d.append(el("summary","行为选项"))
    for(const [key,label]of Object.entries({CLAUDE_CODE_DISABLE_CLAUDE_MDS:"禁用 CLAUDE.md 记忆加载",CLAUDE_CODE_DISABLE_BUNDLED_SKILLS:"禁用内置 Skills 与工作流",CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"禁用后台任务能力"})){
      const c=check(label,r.behaviorEnv?.[key]==="1",v=>edit(["roles",id,"behaviorEnv",key],v?"1":"0"));c.title=key;d.append(c)
    }
    d.append(check("claudeGuard · 全局独立开关",memory().settings.claudeGuardEnabled,v=>edit(["settings","claudeGuardEnabled"],v)),note("扩展守卫，不是 Claude 环境变量。"));box.append(d)
  }
  const guide=el("details");guide.append(el("summary","内置指导与 Skills"),note("由扩展随版本提供。角色提示词、协作规则与 Skills 在此只读；不修改运行钩子或固定角色定义。"));box.append(guide)
}
function renderConnection(box,id,r){
  const details=el("details"),fields=el("div",undefined,"fields")
  const summary=el("summary",`连接参数 · ${r.command||"未设置"} · ${r.permissionMode||"默认"} · ${r.timeoutMs??0}ms`);details.append(summary)
  for(const key of ["command","args","cwd","permissionMode","timeoutMs"]){
    const path=`${id}.${key}`,label=el("label",({command:"可执行程序",args:"参数（JSON 数组）",cwd:"工作目录",permissionMode:"权限策略",timeoutMs:"超时（毫秒）"})[key])
    const input=el(key==="permissionMode"?"select":"input")
    if(key==="permissionMode")for(const v of ["","ask","allow","reject"]){const o=el("option",v||"默认");o.value=v;input.append(o)}
    input.value=queue.state.invalid[path]??(key==="args"?JSON.stringify(r.args??[]):r[key]??"")
    input.setAttribute("aria-invalid",String(Object.hasOwn(queue.state.invalid,path)))
    const hint=note("");label.append(input,hint)
    input.oninput=()=>{
      let value=input.value,invalid=false
       if(key==="args"){try{value=JSON.parse(value);invalid=!Array.isArray(value)||value.length>128||value.some(v=>typeof v!=="string"||v.length>2048||/[\u0000-\u001f\u007f]/u.test(v))}catch{invalid=true}}
       if(key==="timeoutMs"){value=input.value===""?undefined:Number(input.value);invalid=value!==undefined&&(!Number.isSafeInteger(value)||value<0||value>2147483647)}
       if(["command","cwd"].includes(key))invalid=value.length>2048||/[\u0000-\u001f\u007f]/u.test(value)
      if(invalid){queue.state.invalid[path]=input.value;queue.changed()}else{delete queue.state.invalid[path];edit(["roles",id,key],value===""?undefined:value)}
      input.setAttribute("aria-invalid",String(invalid));hint.textContent=invalid?"请填写有效值；输入保留，暂不保存。":""
      summary.textContent=`连接参数 · ${r.command||"未设置"} · ${r.permissionMode||"默认"} · ${r.timeoutMs??0}ms`
    }
    fields.append(label)
  }
  details.append(fields);box.append(details)
}
const catalogLabels={waiting:"等待首次目录（最长约 30 秒）",live:"已连接",stale:"目录已过期 · 等待重新确认",unbound:"尚未关联目录上下文",ambiguous:"多个目录来源 · 无法确认",forbidden:"目录通道未授权",unavailable:"目录暂不可用"}
function renderOptions(){
  if(!queue)return
  const box=$("options"),r=memory().roles[selected],current=r.model||r.wrapperModel,rec=snapshot.recommendations.roles[selected],recommended=rec.model||rec.wrapperModel
  box.replaceChildren();$("cache-status").textContent=refreshing?"正在重新连接 · 保留当前选择":catalogLabels[catalog.status]||"未获取目录"
   if(catalog.receivedAt)$("cache-status").textContent+=` · ${Math.max(0,Math.floor((Date.now()-catalog.receivedAt)/60000))}m 前`
  const values=[...new Set([...(memory().recommendationsEnabled?[recommended]:[]),...catalog.models.map(modelId),current].filter(Boolean))]
  for(const value of values.filter(v=>v.toLowerCase().includes($("search").value.toLowerCase()))){
    const found=catalog.models.some(m=>modelId(m)===value)
    const b=button(`${value===recommended&&memory().recommendationsEnabled?"★ 推荐 · ":""}${value}`,()=>{
      edit(["roles",selected,acp(selected)?"wrapperModel":"model"],value)
      // Keep variant intent, including unknown values, until explicitly changed.
      $("picker").close();renderDetail();$("choose").focus()
    });b.disabled=!found;b.append(note(found?"":value===current?"当前引用保留 · 目录中未找到":"目录中未找到"));box.append(b)
  }
  if(!box.children.length)box.append(note("没有匹配项；当前选择不会改变。"))
}
async function refreshCatalog(refresh=false){
  const epoch=++catalogEpoch,directory=contextDirectory??null,generation=contextEpoch;refreshing=true;renderOptions()
  const current=()=>epoch===catalogEpoch&&generation===contextEpoch&&directory===(contextDirectory??null)
  try{const next=await call("GET",catalogPath(directory,refresh));if(!current())return;if(next.catalogContext?.requestedDirectory!==directory){catalog={models:[],status:"unbound"};return}catalog=next}
  catch(e){if(!current())return;catalog={models:[],status:"unbound"}}
  finally{if(current()){refreshing=false;renderOptions();renderList()}}
}
function group(title){const section=el("section");section.append(el("h2",title));$("settings-view").append(section);return section}
function exportMemory(){showData("本页草稿备份",JSON.stringify({format:"omo-workbench",version:1,draft:memory(),invalidInputs:queue.state.invalid},null,2))}
function confirmNativeImport(){
  showData("导入到私有草稿",`只读取服务端默认配置中的托管字段，不发布；全局写入开关将关闭。${queue.dirty()?" 本页未保存的编辑及无效输入将被替换，请先备份。":""}`,async()=>{
    try{
      if($("review").open)$("review").close()
      preview=null
      await queue.importDraft(body=>call("POST","/workbench/import-native",body),()=>call("GET","/workbench"));render()
    }catch(e){error(e)}
  })
}
function renderSettings(){
  if(!queue)return
  $("settings-view").replaceChildren()
  let g=group("内置推荐")
  g.append(check("使用内置推荐",memory().recommendationsEnabled,v=>{edit(["recommendationsEnabled"],v);renderSettings();renderDetail()}))
  const recommendations=el("details");recommendations.append(el("summary","查看推荐配比"))
  for(const id of ids){const r=snapshot.recommendations.roles[id];recommendations.append(note(`${id} → ${r.model||r.wrapperModel||"未设置"} · ${r.variant||r.requestedVariant||"默认"}`))}
   g.append(recommendations,button("全部恢复推荐",()=>showData("全部恢复推荐","仅恢复模型与等级，保留启停、连接与行为选项；自动保存为私有草稿，不会发布。",()=>{for(const id of ids)resetRole(id);queue.changed();render()})))
   if(snapshot.recommendationUpdate?.available){
     const base=snapshot.recommendationBase
     if(!base||base.version!==memory().recommendationVersion)g.append(note("推荐版本已更新，但旧版基线不可确认。请逐个角色查看推荐并手动选择；不会自动替换。"))
     else g.append(button("更新内置推荐",()=>showData("更新内置推荐","只更新仍与旧推荐一致的模型与等级；保留自定义值、启停及连接设置。仅保存草稿。",()=>{
       for(const id of ids)for(const key of acp(id)?["wrapperModel","requestedVariant"]:["model","variant"]){
         if(equal(memory().roles[id][key],base.roles[id]?.[key])){
           const value=snapshot.recommendations.roles[id][key]
           if(value===undefined)delete memory().roles[id][key];else memory().roles[id][key]=value
         }
       }
       memory().recommendationVersion=snapshot.recommendations.version;queue.changed();render()
     })))
   }
  g=group("发布与生效")
  g.append(check("允许写入全局配置",memory().settings.allowGlobalWrites,v=>edit(["settings","allowGlobalWrites"],v)),check("发布后自动重载",false,()=>{},true),
    note("当前 OpenChamber SDK 无公开重载或重启接口，请自行重载外部 OpenCode。"),
    note("托管角色以扩展为准，其余配置与 opencode.json 原样保留。"),
    note(snapshot.capabilities.hotApply?"热刷新以服务端预览分类为准。":"热刷新尚未验证；当前变更通过发布写入，运行态另行确认。"))
  g=group("诊断日志")
  g.append(check("本页诊断日志 · 30 分钟后关闭",logs,v=>{logs=v;clearTimeout(logTimer);if(v)logTimer=setTimeout(()=>{logs=false;renderSettings()},1800000)}),
    note("仅本页内存元数据，刷新即清除；未接入持久日志目录。不记录配置正文、环境变量或凭据。"),
    button("导出日志",()=>showData("诊断元数据",trace.export())),button("清空日志",()=>trace.clear()))
  g=group("数据与环境");const data=el("details");data.append(el("summary","备份与环境"),
    note("卸载会删除扩展私有草稿。仅备份 opencode.json 无法保留个人覆盖。"),
     button("导出配置",exportMemory),
     button("导入配置备份",()=>{$("import-error").textContent="";openDialog("import-dialog")}),
     note("停止托管：先关闭「允许写入全局配置」并导出备份，再卸载扩展。卸载不回滚已写入的原生配置；后续请自行维护。"),
    note("OMO 与依赖由用户 dotfiles/opencode.json 预置；扩展不打包、不安装。运行中是否采用此配置尚未确认。"))
   g.append(data)
   if(snapshot.capabilities.nativeImport)data.append(button("从现有配置导入",confirmNativeImport))
}
function renderFooter(){
  if(!queue)return
  const s=queue.state,dirty=queue.dirty()
  $("status").textContent=operationBusy?"发布中…":({waiting:"等待自动保存…",saving:"正在保存草稿…",invalid:"输入未完成 · 已保留",failed:"草稿保存失败",conflict:"草稿冲突 · 编辑已保留"})[s.phase]||"已自动保存"
  $("retry").hidden=s.phase!=="failed"
  const count=applied?differences(applied,s.memory).length:0
  $("publish").textContent=count?`发布 · ${count}`:"发布"
  $("publish").hidden=Boolean(applied&&!count)
  if(applied&&!count&&!dirty)$("status").textContent="已同步"
  $("publish").disabled=dirty||s.phase!=="saved"||previewBusy||operationBusy||Boolean(operation)
   $("restore").disabled=!applied||operationBusy||Boolean(operation)||equal(applied,memory())||["saving","conflict","failed"].includes(s.phase)
}
function render(){
  const roles=tab==="roles";$("roles-view").hidden=!roles;$("settings-view").hidden=roles
  $("tab-roles").setAttribute("aria-current",roles?"page":"false");$("tab-settings").setAttribute("aria-current",roles?"false":"page")
  renderList();renderDetail();renderSettings();renderFooter()
}
async function openPreview(){
  if($("publish").disabled)return
  previewBusy=true;renderFooter()
  try{
    preview=await call("POST","/workbench/preview",{revision:queue.state.revision,mode:"publish"})
    $("diffs").replaceChildren();$("risk").replaceChildren()
    for(const c of preview.changes){const row=el("div",undefined,"diff");row.append(el("strong",`${c.classification==="hot"?"可热刷新":"需重载"} · ${c.field}`),el("div",JSON.stringify(c.before??"未设置"),"before"),el("div","→ "+JSON.stringify(c.after??"未设置"),"after"));$("diffs").append(row)}
    for(const blocker of preview.blockers)$("risk").append(note(blocker))
    if(!preview.changes.length)$("diffs").append(note("无字段变化。"))
    if(preview.writeTarget)$("risk").append(note(`写入服务所在主机的配置：${preview.writeTarget.path}`),note("此路径不是当前会话的项目目录；尚未确认运行中的 OpenCode 使用它。"))
    const acknowledgements=new Set()
    const labels={
      nativeCandidateRoot:"我确认以上默认配置目录就是本次写入目标",
      defaultManagedHost:"我确认修改的是扩展服务所在主机的文件",
      workPaused:"我已暂停可能同时修改此配置的工作",
      overwriteAuthority:"我授权扩展覆盖所列托管字段",
      userConsent:"我同意本次写入，不将写入视为运行态已生效",
      firstTakeover:"我确认首次接管所列已有配置",
      externalOverwrite:"我确认覆盖预览中检测到的外部修改",
       riskyACP:"我确认所列 ACP 可执行程序或权限变更",
       acpExecution:"我确认所列 ACP 可执行程序或权限变更",
       guardEnable:"我确认启用全局 claudeGuard 守卫",
       targetAuthorization:"我确认本次配置目标授权；目标发生变化时需重新确认",
    }
    const updateConfirm=()=>{$("confirm").disabled=!usablePreview(preview)||!preview.writeTarget||preview.blockers.length>0||preview.requiredConfirmations.some(key=>!acknowledgements.has(key))||operationBusy||Boolean(operation)}
     for(const key of preview.requiredConfirmations)$("risk").append(check(labels[key]||`我确认此服务端风险项：${key}`,false,v=>{if(v)acknowledgements.add(key);else acknowledgements.delete(key);updateConfirm()}))
     if(preview.requiredConfirmations.includes("externalOverwrite")&&snapshot.capabilities.nativeImport)$("risk").append(button("导入外部修改",confirmNativeImport))
    $("confirm").onclick=()=>publish(acknowledgements)
    updateConfirm()
    if(preview.risks.length)$("risk").append(note(preview.risks.join(" · ")))
    openDialog("review")
  }catch(e){error(e)}finally{previewBusy=false;renderFooter()}
}
async function queryOperation(){
  if(!operation)return
  const id=operation.operationId
  try{const result=await call("GET",`/workbench/operations/${id}`);handleOperation(result.operation,id)}
  catch(e){if(operation?.operationId===id)banner(`发布结果仍未确认 · ${e.code||"查询失败"}；不会自动重试发布。`,[["查询状态",queryOperation]])}
}
function clearStoredOperation(id){
  try{const stored=JSON.parse(localStorage.getItem(operationStorageKey)||"null");if(stored?.operationId===id)localStorage.removeItem(operationStorageKey)}catch{}
}
function handleOperation(result,expectedId){
  if(operation?.operationId!==expectedId)return
  if(result?.operationId!==expectedId){banner("发布结果仍未确认 · 返回编号不匹配",[["查询状态",queryOperation]]);return}
  if(["pending","unknown"].includes(result.state)){operation=result;banner("发布结果未知",[["查询状态",queryOperation]])}
  else{
    if(result.state==="applied"){$("reload").hidden=false;banner("已写入配置 · 待重载。当前运行实例是否采用此目录尚未确认。")}
    else banner(`发布未完成 · ${result.code||"已阻止"}`)
    operation=null;clearStoredOperation(expectedId)
    // Refresh server metadata/baseline, never replace newer memory or saved drafts.
    call("GET","/workbench").then(next=>{snapshot=next;applied=next.appliedDraft;renderFooter()}).catch(error)
  }
  renderFooter()
}
async function publish(acknowledgements){
  if($("confirm").disabled||!usablePreview(preview)||operation||operationBusy)return
  const body={operationId:crypto.randomUUID(),previewId:preview.previewId,revision:preview.revision,diffDigest:preview.diffDigest,targetId:preview.writeTarget.targetId,confirmations:[...acknowledgements]}
  try{
    // Keep the recovery handle before transmission, even across frame reloads.
    localStorage.setItem(operationStorageKey,JSON.stringify({operationId:body.operationId}))
  }catch{banner("无法保存发布恢复编号；未发送发布请求。请允许此面板使用本地存储后重试。");return}
  operation={operationId:body.operationId,state:"pending"};operationBusy=true;$("review").close();renderFooter()
  try{const result=await call("POST","/workbench/operations",body);handleOperation(result.operation,body.operationId)}
  catch(e){
    if(operation?.operationId!==body.operationId)return
    if(e.disposition?.operationStarted===false){
      operation=null;clearStoredOperation(body.operationId);preview=null
      banner(`未提交发布 · ${e.code||"请求被拒绝"}。草稿已保留，请重新预览。`)
    }else banner("发布结果未知 · 不会自动重试",[["查询状态",queryOperation]])
  }
  finally{operationBusy=false;renderFooter()}
}
async function selectContext(directory){
  directory=typeof directory==="string"&&directory?directory:null
  if(directory===(contextDirectory??null))return
  contextDirectory=directory
  const epoch=++contextEpoch,requestEpoch=++catalogEpoch;refreshing=false
  // SDK context is a selector claim only; never use it as a native write target.
  catalog={models:[],status:directory?"waiting":"unbound"};renderOptions();renderList()
  if(!directory)return
  const current=()=>epoch===contextEpoch&&requestEpoch===catalogEpoch&&directory===contextDirectory
  try{const next=await call("POST","/workbench/context",{directory});if(current()){catalog=next.catalogContext?.requestedDirectory===directory?next:{models:[],status:"unbound"};renderOptions();renderList()}}
  catch(e){if(current()){catalog={models:[],status:"unbound"};renderOptions()}}
}
$("tab-roles").onclick=()=>{tab="roles";render()}
$("tab-settings").onclick=()=>{tab="settings";render()}
$("role-search").oninput=renderList
$("search").oninput=renderOptions
$("refresh").onclick=()=>refreshCatalog(true)
$("picker-close").onclick=()=>$("picker").close()
$("cancel").onclick=()=>$("review").close()
$("data-close").onclick=()=>$("data-dialog").close()
$("import-close").onclick=()=>$("import-dialog").close()
$("import-confirm").onclick=()=>{
  let candidate
  try{candidate=parseBackup($("import-text").value)}catch(e){$("import-error").textContent=e.message;return}
  showData("确认导入备份",`导入只保存私有草稿，不发布。${queue.dirty()?" 将替换当前未保存编辑和无效输入，请先备份。":" 将替换当前草稿。"}`,async()=>{
    try{
      preview=null
      await queue.importDraft(body=>call("PATCH","/workbench/draft",body),()=>call("GET","/workbench"),candidate)
      if(queue.state.phase!=="failed"&&queue.state.phase!=="conflict")$("import-dialog").close()
      render()
    }catch(e){$("import-error").textContent=e.message}
  })
}
$("retry").onclick=async()=>{await queue.retry();render()}
$("publish").onclick=openPreview
$("restore").onclick=()=>showData("还原草稿","丢弃尚未应用的改动，恢复最近写入的配置基线？",()=>{if(!applied)return;queue.state.memory=clone(applied);queue.state.invalid={};queue.changed();render()})
window.addEventListener("beforeunload",event=>{if(queue?.dirty()){event.preventDefault();event.returnValue=""}})
try{
  host=connectHost()
   host.onReady?.(context=>{applyHostReady(context,document.documentElement);selectContext(context.directory)})
   host.onDirectory?.(selectContext)
  snapshot=await call("GET","/workbench")
  queue=createDraftQueue(snapshot,body=>call("PATCH","/workbench/draft",body),stateChanged)
  applied=snapshot.appliedDraft
  try{const saved=JSON.parse(localStorage.getItem(operationStorageKey)||"null");if(saved&&/^[a-zA-Z0-9_-]+$/.test(saved.operationId)){operation=saved;banner("上次发布结果待查询",[["查询状态",queryOperation]])}}catch{}
  if(snapshot.runtime?.state==="pending")$("reload").hidden=false
  render();refreshCatalog()
  // Reading the service cache does not force publisher refreshes.
  setInterval(()=>refreshCatalog(),15000)
}catch(e){error(e);$("status").textContent="未连接";banner(e.message,[["重新连接",()=>window.location.reload()]])}
