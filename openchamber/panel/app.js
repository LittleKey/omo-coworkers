import { connectHost } from "./vendor/host.js"
import { applyHostReady } from "./vendor/theme.js"
import { request, roleIntent, hasChanges, usablePreview, changeSummary } from "./model.js"
import { createDiagnostics } from "./diagnostics.js"
const $ = id => document.getElementById(id)
const el = (tag,text,cls) => { const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n }
const btn = (text,fn,cls) => { const n=el("button",text,cls);n.type="button";n.onclick=fn;return n }
let host,snapshot,catalog={catalog:[],variants:{}},contributions,selected,draft,preview,writing=false,reading=false,pendingLeave
let generation=0
let draftBaseline=null
let catalogEpoch=0,catalogStatus="目录尚未读取",commitUnknown=false,needsReadback=false
let invalidInputs={}
const behaviorLabels={
  CLAUDE_CODE_DISABLE_CLAUDE_MDS:["禁用 CLAUDE.md 记忆加载","包含用户、项目与自动记忆文件。"],
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS:["禁用内置 Skills 与工作流","不影响插件及个人目录中的 Skills。"],
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:["禁用后台任务能力","限制后台工具运行与自动转后台；不等于关闭所有后台会话。"],
}
const current=()=>selected?.startsWith("acp:")?snapshot?.acpAgents?.find(c=>`acp:${c.id}`===selected):snapshot?.capabilities.find(c=>c.id===selected)
const dirty=()=>Object.keys(invalidInputs).length>0||(selected?.startsWith("acp:")?Boolean(draftBaseline&&draft&&JSON.stringify(draft)!==JSON.stringify(draftBaseline)):hasChanges(draftBaseline,draft))
const titleOf=c=>({"document-role":"文档协作","lark-role":"飞书操作","collaboration":"协作指导","claude-acp-guidance":"Claude 指导","antigravity-acp-guidance":"Antigravity 指导"})[c.id]||c.title
const trace=createDiagnostics(()=>{$("trace-output").value=trace.export()})
const call=(method,path,body)=>request({serviceRequest:input=>trace.serviceRequest(host,input)},method,path,body)
$("trace-clear").onclick=()=>{trace.clear();$("trace-status").textContent="已清空本页临时日志。"}
$("trace-copy").onclick=async()=>{
  const output=$("trace-output"),text=trace.export()
  try{await navigator.clipboard.writeText(text);$("trace-status").textContent="已复制安全元数据日志。"}
  catch{output.focus();output.select();$("trace-status").textContent="无法自动复制；已选中日志，请手动复制。"}
}
function notice(text,error=false){$("notice").textContent=text;$("notice").dataset.error=String(error)}
function showError(e){notice(`${e.code || "未完成"} · ${e.message} ${e.nextAction || "请核对设置后重试。"}${e.code==="CONFLICT"?" 草稿已保留；读取最新状态后重新核对。":""}`,true)}
async function action(fn){if(writing||reading)return;if(needsReadback){notice("提交结果未知。请先点击刷新只读核对；迟到写入仍可能发生，不会自动重试。",true);return}trace.add("action-begin");writing=true;lock();try{await fn()}catch(e){showError(e)}finally{writing=false;lock()}}
function lock(){
  for(const n of document.querySelectorAll("[data-write]"))n.disabled=writing||reading||needsReadback
  const detail=$("detail");detail.inert=writing
  $("list").inert=writing
  document.querySelector(".support").inert=writing
  $("leave").inert=writing
  $("stay").disabled=$("discard-leave").disabled=writing
  $("commit").disabled=writing||reading||needsReadback||!usablePreview(preview)||(preview?.changes.some(c=>c.risk)&&!$("risk-check")?.checked)
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
    invalidInputs={}
    if(id?.startsWith("acp:")&&c){
      draft={enabled:c.enabled,settings:Object.fromEntries(Object.entries(c.settings).map(([k,v])=>[k,v.value])),behaviorEnv:Object.fromEntries((c.env||[]).filter(v=>Object.hasOwn(behaviorLabels,v.key)).map(v=>[v.key,v.value]))}
      draftBaseline=structuredClone(draft)
    }else{
      draftBaseline=c?.settings?structuredClone(c):null
      draft=c?.settings?{enabled:c.settings.enabled,model:c.settings.model.value,variant:c.settings.variant.value,variantChosen:false}:null
    }
  }
  $("workspace").dataset.open=String(Boolean(c));renderList();renderDetail()
  if(c)$("detail-title").focus();else document.querySelector("#list button")?.focus()
}
$("stay").onclick=()=>{if(writing)return;$("leave").hidden=true;$("detail-title")?.focus()}
$("discard-leave").onclick=()=>{if(writing)return;$("leave").hidden=true;open(pendingLeave)}
function renderList(){
  $("list").replaceChildren()
  for(const kind of ["role","acp","guidance"]){
    $("list").append(el("p",kind==="role"?"角色":kind==="acp"?"ACP 代理":"项目设置","group-label"))
    if(kind==="acp"){
      for(const c of snapshot.acpAgents||[]){const b=btn(c.id,()=>navigate(`acp:${c.id}`));b.dataset.id=`acp:${c.id}`;b.setAttribute("aria-current",String(selected===`acp:${c.id}`));$("list").append(b)}
      continue
    }
    for(const c of snapshot.capabilities.filter(c=>c.kind===kind)){
      if(kind==="guidance"&&c.id!=="collaboration")continue
      const b=btn("",()=>navigate(c.id));b.dataset.id=c.id;b.setAttribute("aria-current",String(c.id===selected))
      b.append(el("span",c.id==="collaboration"?"任务分工与协作规则":titleOf(c)))
      $("list").append(b)
    }
  }
}
function change(){generation++;invalidate();renderSave()}
function renderDetail(){
  const box=$("detail");box.replaceChildren();const c=current()
  if(!c){box.append(el("p","选择一项能力，查看项目内容与可用设置。","empty"));return}
  const back=btn("← 返回能力",()=>navigate(null));back.id="back";box.append(back)
  if(selected.startsWith("acp:")){renderAcp(box,c);return}
  const title=el("h2",titleOf(c));title.id="detail-title";title.tabIndex=-1;box.append(title)
  box.append(el("p",c.kind==="role"?"只调整启用、模型与支持的思考等级。项目正文与依赖不在这里编辑。":"采用项目指导，不等于启停内建代理或外部 ACP 服务。","muted"))
  if(c.id==="collaboration")box.append(el("p","为 orchestrator、oracle、explorer、designer、fixer 提供任务分工与协作约定。不是新代理，不配置模型，也不启动后台服务。","muted"))
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
  enhancePicker(select,"选择模型")
  const full=el("p",draft.model||model.inheritedValue||"未解析模型","model-full");select.addEventListener("change",()=>full.textContent=draft.model);box.append(full)
  const status=el("p",catalogStatus,"muted");status.id="catalog-status";box.append(status)
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
    enhancePicker(input,"思考等级")
    if(!model.editable)region.append(el("p",model.reason||"模型来源只读，因此思考等级也不可修改。","muted"))
    if(!(catalog.variants[draft.model]||[]).length)region.append(el("p","没有可确认的等级目录；只可保留当前值或明确选择默认，不猜测 low/high。","muted"))
  }renderVariant()
}
function renderSave(){
  const box=$("save");if(!box)return;box.replaceChildren();box.className=dirty()?"save":""
  if(!dirty())return
  box.append(el("p","有未保存设置 · 不会改写项目提示词或 Skills","muted"))
  const actions=el("div",undefined,"actions")
  const save=btn("保存设置",()=>{trace.add("save-click");return action(async()=>{
    if(!current()?.settings)throw new Error("配置暂不可用；草稿保留，请修复配置后刷新。")
    if(Object.keys(invalidInputs).length||[...$("detail").querySelectorAll("input")].some(n=>!n.checkValidity()))throw new Error("请先修正输入格式，再保存。")
    if(selected.startsWith("acp:")){
      const c=current(),settings=Object.fromEntries(Object.entries(draft.settings).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(draftBaseline.settings[k])))
      const behaviorEnv=Object.fromEntries(Object.entries(draft.behaviorEnv||{}).filter(([k,v])=>v!==draftBaseline.behaviorEnv?.[k]))
      await previewIntent({kind:"acp-settings",agentId:c.id,...(draft.enabled!==draftBaseline.enabled?{enabled:draft.enabled}:{}),...(Object.keys(settings).length?{settings}:{}),...(Object.keys(behaviorEnv).length?{behaviorEnv}:{})})
    }else await previewIntent(roleIntent(draftBaseline,draft,current()),true)
  })})
  const c=current(),available=c?.settings&&(!selected.startsWith("acp:")||(c.exists&&c.editable&&Object.entries(draft.settings).every(([k,v])=>JSON.stringify(v)===JSON.stringify(draftBaseline.settings[k])||c.settings[k]?.editable)&&Object.entries(draft.behaviorEnv||{}).every(([k,v])=>v===draftBaseline.behaviorEnv?.[k]||c.env?.find(e=>e.key===k)?.editable)&&(draft.enabled===draftBaseline.enabled||c.membershipEditable)))
  if(available)save.dataset.write=""
  else {save.disabled=true;box.append(el("p","配置暂不可用，保存已暂停；草稿仍保留。修复配置后刷新并重新核对。","muted"))}
  actions.append(btn("取消修改",()=>open(selected)),save);box.append(actions)
}
function enhancePicker(select,title){
  select.hidden=true
  const trigger=btn(select.selectedOptions[0]?.textContent||title,()=>{
    if(select.id==="model"){
      for(const value of catalog.catalog)if(![...select.options].some(o=>o.value===value)){const option=el("option",value);option.value=value;select.append(option)}
    }
    if(select.id==="variant"){
      for(const value of catalog.variants[draft.model]||[])if(![...select.options].some(o=>o.value===`id:${value}`)){const option=el("option",value);option.value=`id:${value}`;select.append(option)}
    }
    const dialog=el("dialog",undefined,"picker"),head=el("div",undefined,"heading"),search=el("input"),list=el("div")
    search.type="search";search.placeholder="搜索";search.setAttribute("aria-label",`搜索${title}`)
    list.setAttribute("role","listbox");list.className="picker-options";list.id="picker-options";dialog.setAttribute("aria-label",title)
    const close=()=>dialog.close()
    head.append(el("strong",title),btn("返回",close));dialog.append(head,search,list);document.body.append(dialog)
    const render=()=>{
      list.replaceChildren()
      for(const option of [...select.options].filter(o=>o.textContent.toLowerCase().includes(search.value.toLowerCase()))){
        const row=btn(option.textContent,()=>{select.value=option.value;select.dispatchEvent(new Event("change",{bubbles:true}));trigger.textContent=option.textContent;close()})
        row.setAttribute("role","option");row.setAttribute("aria-selected",String(select.value===option.value));list.append(row)
      }
      if(!list.children.length)list.append(el("p","没有匹配项；请修改搜索词。","muted"))
    }
    search.oninput=render;search.onkeydown=e=>{if(e.key==="ArrowDown"){e.preventDefault();list.querySelector("button")?.focus()}}
    list.onkeydown=e=>{const rows=[...list.querySelectorAll("button")],i=rows.indexOf(document.activeElement);if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();rows[(i+(e.key==="ArrowDown"?1:-1)+rows.length)%rows.length]?.focus()}}
    dialog.onclose=()=>{trigger.setAttribute("aria-expanded","false");dialog.remove();trigger.focus()}
    trigger.setAttribute("aria-expanded","true");render();dialog.showModal();search.focus()
  })
  trigger.className="picker-trigger";trigger.disabled=select.disabled;trigger.setAttribute("role","combobox");trigger.setAttribute("aria-label",title);trigger.setAttribute("aria-expanded","false");trigger.setAttribute("aria-haspopup","dialog")
  select.insertAdjacentElement("afterend",trigger)
}
function renderAcp(box,c){
  const title=el("h2",`${c.id} · ACP 代理`);title.id="detail-title";title.tabIndex=-1;box.append(title)
  box.append(el("p","配置外部代理连接，不在这里运行命令或验证连接。","muted"))
  if(c.reason)box.append(el("p",c.reason,"muted"))
   const enabled=el("input");enabled.type="checkbox";enabled.id="enabled";enabled.checked=draft.enabled===true;enabled.indeterminate=c.enabled===null;enabled.disabled=!c.editable||!c.exists||c.membershipEditable===false||c.enabled===null
   const label=el("label",undefined,"check");label.append(enabled,el("span","启用（配置）"));enabled.onchange=()=>{draft.enabled=enabled.checked;change()};box.append(label)
   if(c.membershipReason||c.enabled===null)box.append(el("p",c.membershipReason||"启用状态无法读取；请修复配置后刷新。","muted"))
  const names={command:"可执行程序",args:"参数（JSON 字符串数组）",cwd:"工作目录",wrapperModel:"包装层模型",timeoutMs:"超时（毫秒）",permissionMode:"权限策略"}
  for(const [key,control] of Object.entries(c.settings)){
    const label=el("label",names[key]||key);label.htmlFor=`acp-${key}`
    const input=el(key==="permissionMode"?"select":"input");input.id=`acp-${key}`
    if(key==="permissionMode"){for(const v of ["ask","allow","reject"]){const o=el("option",v);o.value=v;input.append(o)}}
    else input.type=key==="timeoutMs"?"number":"text"
    input.value=invalidInputs[key]?.raw??(key==="args"?JSON.stringify(draft.settings[key]??[]):draft.settings[key]??"")
    if(invalidInputs[key])input.setCustomValidity(invalidInputs[key].message)
    input.disabled=!control.editable||!c.exists
    if(key==="timeoutMs"){input.min="0";input.max="2147483647";input.step="1"}
    input.oninput=()=>{try{
      let value=input.value
      if(key==="args"){value=JSON.parse(value);if(!Array.isArray(value)||!value.every(v=>typeof v==="string"))throw Error("参数必须是 JSON 字符串数组")}
      if(key==="timeoutMs"){value=Number(value);if(!input.value||!Number.isInteger(value)||value<0||value>2147483647)throw Error("超时必须是有效非负整数")}
      if(["cwd","wrapperModel"].includes(key)&&value==="")value=null
       draft.settings[key]=value;delete invalidInputs[key];input.setCustomValidity("");change()
     }catch(e){invalidInputs[key]={raw:input.value,message:e.message};input.setCustomValidity(e.message);change();notice(e.message,true)}}
     const descriptions={command:"可执行程序名称或路径；不在此运行。",args:"每个参数单独一个字符串；不是 shell 命令。",cwd:"留空使用会话目录。",wrapperModel:"仅控制包装层，不是 ACP 内部模型。",timeoutMs:"0 表示不设限。",permissionMode:"内部权限策略；宿主启动权限仍单独生效。"}
     const row=el("div",undefined,"setting-row"),text=el("div")
     text.append(label,el("p",control.reason||descriptions[key],"source"));row.append(text,input);box.append(row)
  }
  box.append(el("p","包装层模型不是 ACP 内部模型；权限策略不是启停。超时 0 表示不设限；清空工作目录使用会话目录。","muted"))
   if(c.editable&&(!c.exists||!c.settings.command.present))box.append(btn("创建 / 补齐项目配置",()=>action(async()=>{
    requireClean();await previewIntent({kind:"acp-create",agentId:c.id,settings:{command:c.suggestion.command,args:c.suggestion.args}})
  })),el("p",`建议：${c.suggestion.command} ${JSON.stringify(c.suggestion.args)}。这是可移植建议，不代表已安装或连接成功；已有字段保留。`,"muted"))
   const environment=el("details");environment.append(el("summary","环境与项目行为"),el("p","只修改本地环境覆盖，不读取进程环境，也不验证运行中状态。","muted"))
   for(const item of c.env||[]){
     const description=behaviorLabels[item.key]
     if(!description){environment.append(el("p",`${item.key}：${item.key==="ANTHROPIC_MODEL"?"内部模型的可用列表未验证，保持只读。":"等级取决于当前内部模型与运行时限制，保持只读。"}`,"source"));continue}
     const row=el("div",undefined,"setting-row"),text=el("div"),label=el("label",description[0]),select=el("select")
     select.id=`behavior-${item.key}`;label.htmlFor=select.id
     text.append(label,el("p",description[1],"source"))
     const editable=c.id==="claude"&&c.exists&&item.editable
     if(!editable){const option=el("option",item.present?"现有值受保护，保留且不回显":"继承 / 未设置本地覆盖");option.value="readonly";select.append(option);select.disabled=true;text.append(el("p",item.reason||"当前配置不可编辑。","source"))}
     else{
       for(const [value,title] of [["inherit","继承（删除本地覆盖）"],["1","禁用（写入 1）"],["0","不禁用（写入 0）"]]){const option=el("option",title);option.value=value;select.append(option)}
       select.value=draft.behaviorEnv?.[item.key]??"inherit"
       select.onchange=()=>{draft.behaviorEnv[item.key]=select.value==="inherit"?null:select.value;change()}
       text.append(el("p",item.present?"当前有本地覆盖。":"未设置本地覆盖；进程环境未知。","source"))
     }
     row.append(text,select);environment.append(row)
   }
  box.append(environment)
  if(c.exists&&c.editable){const check=el("input");check.type="checkbox";const consent=el("label",undefined,"check");consent.append(check,el("span","允许采用项目指导并替换已识别的内联覆盖。"));box.append(consent,btn("更新项目指导",()=>action(async()=>{requireClean();if(!check.checked)throw Error("请确认采用范围");await previewIntent({kind:"adopt-content",capabilityId:`${c.id}-acp-guidance`,confirmInlineReplacement:true})})))}
  const save=el("div");save.id="save";box.append(save);renderSave()
}
async function previewIntent(intent,auto=false){
  trace.add("preview-send")
  const owner=selected,epoch=generation
  let result
  try{result=await call("POST","/intent-preview",{revision:snapshot.revision,intent})}
  catch(e){e.message=`预览未完成（未提交写入）：${e.message}`;throw e}
  trace.add("preview-ready")
  if(owner!==selected||epoch!==generation){notice("设置已变化，旧预览已丢弃。请重新保存。");return}
  if(auto&&!result.changes.some(c=>c.risk)){
    await commitConfig({previewId:result.previewId},owner,epoch)
  }else showPreview(result)
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
   if(result.changes.some(c=>c.risk)){const label=el("label",undefined,"check"),check=el("input");check.type="checkbox";check.id="risk-check";check.onchange=lock;label.append(check,el("span",result.changes.some(c=>c.risk==="behavior-change")?"我已核对本次 Claude 行为变化；它可能影响记忆、内置工作流或后台任务。保存不代表运行中已生效。":"确认本次列出的风险修改。"));$("risk").append(label)}
  $("confirm-title").focus();lock()
}
$("cancel-preview").onclick=()=>{invalidate();$("detail-title")?.focus()}
$("commit").onclick=()=>action(async()=>{
  if(!usablePreview(preview))throw new Error("预览已失效，请重新保存。")
  const risk=preview.changes.some(c=>c.risk);if(risk&&!$("risk-check")?.checked)throw new Error("请确认本次风险。")
  const owner=selected,epoch=generation
  await commitConfig({previewId:preview.previewId,...(risk?{confirmRisk:true}:{})},owner,epoch)
})
async function commitConfig(body,owner,epoch){
  trace.add("commit-send")
  try{await call("PATCH","/config",body)}
  catch(e){
    if(e.code==="HOST_TIMEOUT"){
      commitUnknown=true;needsReadback=true;invalidate()
      notice("提交结果未知（HOST_TIMEOUT）。请求可能已写入或稍后写入。草稿保留；请先刷新只读核对，不会自动重试。",true)
      return
    }
    e.message=`提交未获确认：${e.message}`;throw e
  }
  trace.add("commit-response");commitUnknown=false
  if(owner!==selected||epoch!==generation){invalidate();notice("已提交旧预览；当前草稿保留，请重新读取核对。");return}
  invalidate()
  try{await refresh(false,true);notice("已保存到磁盘 · 运行中未确认。需要时通过宿主 UI 重载。")}
  catch(e){needsReadback=true;notice(`已保存到磁盘，但状态刷新失败（${e.code||"READ_FAILED"}）。草稿保留；请刷新核对，不要重复提交。`,true)}
}
async function refreshCatalog(){
  const epoch=++catalogEpoch
  catalogStatus="模型目录读取中；配置操作无需等待。"
  if($("catalog-status"))$("catalog-status").textContent=catalogStatus
  try{
    const next=await call("GET","/models")
    if(epoch!==catalogEpoch)return
    catalog=next;catalogStatus="模型目录已更新；重新打开选择器可用。"
  }catch(e){if(epoch!==catalogEpoch)return;catalogStatus=`模型目录读取失败（${e.code||"READ_FAILED"}）；保留缓存，可点击刷新重试。`}
  if($("catalog-status"))$("catalog-status").textContent=catalogStatus
  // Never rebuild detail, move focus, or alter the draft on a catalog response.
}
async function refresh(preserve=true,internal=false){
  if(reading||(writing&&!internal))return
  trace.add("readback")
  const epoch=generation,owner=selected
  reading=true;lock()
  try{
    const next=await call("GET","/snapshot"),wasDirty=dirty()
    if(epoch!==generation||owner!==selected){notice("读取期间设置已变化；草稿保留，请重新刷新。");return}
    snapshot=next;renderSupport();generation++;renderOpen(selected,preserve&&wasDirty)
    if(preserve&&wasDirty)notice("已读取最新状态，草稿保留；请重新核对后保存。")
    needsReadback=false
    if(commitUnknown)notice("已只读刷新，原提交结果仍未知；迟到写入仍可能发生。草稿保留，请核对后重新预览，不会自动重试。",true)
  }finally{reading=false;lock()}
}
function requireClean(){if(dirty())throw new Error("请先保存或取消当前能力设置，再执行此操作。")}
function renderSupport(){
  $("diagnostics").replaceChildren(...snapshot.diagnostics.map(d=>el("p",`${d.code} · ${d.reason} ${d.nextAction}`,"muted")))
  $("history").replaceChildren(...snapshot.history.map(h=>{
    const b=btn(`预览撤销 · ${h.summary}`,()=>action(async()=>{requireClean();showPreview(await call("POST","/undo-preview",{transactionId:h.id}))}));b.disabled=!h.undoable;return b
  }))
  $("recovery").replaceChildren()
  if(snapshot.diagnostics.some(d=>/RECOVERY|PENDING/.test(d.code)))$("recovery").append(btn("恢复中断写入",()=>action(async()=>{requireClean();await call("POST","/recover",{confirm:true});await refresh(true,true);notice("恢复请求完成；请核对最新诊断。")})))
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
$("refresh").onclick=()=>{void refreshCatalog();refresh().catch(e=>{e.message=`状态读取失败：${e.message}`;showError(e)})}
window.addEventListener("beforeunload",e=>{if(dirty()){e.preventDefault();e.returnValue=""}})
setInterval(lock,15000)
try{host=connectHost();host.onReady?.(context=>applyHostReady(context,document.documentElement));await Promise.all([
  (void refreshCatalog()),
  refresh().catch(showError),
  call("GET","/contributions").then(data=>{contributions=data;renderGuard()}).catch(showError),
])}catch(e){showError(e)}
