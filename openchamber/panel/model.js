export const VERSION = "8.0.0"
const routes = new Set(["GET /workbench", "GET /models", "GET /models?refresh=true", "POST /workbench/context", "PATCH /workbench/draft", "POST /workbench/import-native", "POST /workbench/preview", "POST /workbench/operations"])
function catalogRoute(method,path){
  if(method!=="GET"||!path.startsWith("/models?")||path.includes("#"))return false
  try {
    const raw=path.slice(8),params=new URLSearchParams(raw)
    for(const part of raw.split("&"))decodeURIComponent(part)
    if([...params.keys()].some(k=>!["directory","refresh"].includes(k))||params.getAll("directory").length>1||params.getAll("refresh").length>1)return false
    const directory=params.get("directory")
    return (!params.has("refresh")||params.get("refresh")==="true")&&(!params.has("directory")||(directory.startsWith("/")&&directory.length<=4096&&!/[\u0000-\u001f\u007f]/u.test(directory)))
  }catch{return false}
}
export const catalogPath=(directory,refresh=false)=>`/models${directory?`?directory=${encodeURIComponent(directory)}${refresh?"&refresh=true":""}`:refresh?"?refresh=true":""}`
export async function request(host, method, path, body) {
  if (!routes.has(`${method} ${path}`) && !catalogRoute(method,path) && !(method === "GET" && /^\/workbench\/operations\/[a-zA-Z0-9_-]+$/.test(path))) throw new Error("INVALID_ROUTE")
  const serializedBody = body === undefined ? undefined : JSON.stringify(body)
  if (serializedBody !== undefined && new TextEncoder().encode(serializedBody).length > 63000) throw new Error("请求过大")
  const result = await host.serviceRequest({method,path,...(serializedBody === undefined ? {} : {body:serializedBody})})
  let data
  try { data = typeof result.body === "string" ? JSON.parse(result.body) : result.body } catch {}
  if (result.status < 200 || result.status >= 300 || !data?.ok) {
    const error = new Error(data?.error?.reason || "无法读取本地服务")
     Object.assign(error,{code:data?.error?.code || "SERVICE_UNAVAILABLE",nextAction:data?.error?.nextAction || "请检查扩展服务授权后重试。"})
     for(const key of ["field","resource"])if(typeof data?.error?.[key]==="string")error[key]=data.error[key]
     if(method==="POST"&&path==="/workbench/operations"&&result.status>=400&&result.status<500&&data?.error?.disposition?.operationStarted===false)error.disposition={operationStarted:false}
    throw error
  }
  return data
}
export const ids = ["orchestrator","explorer","oracle","designer","fixer","observer","council","councillor","document-writer","lark-operator","claude","antigravity"]
export const locked = id => ["orchestrator","councillor"].includes(id)
export const acp = id => ["claude","antigravity"].includes(id)
export const clone = value => structuredClone(value)
export const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b)
export const modelId = model => `${model.providerID}/${model.id}`
export function parseBackup(text) {
  if(new TextEncoder().encode(text).length>60000)throw new Error("备份不得超过 60 KB")
  const value=JSON.parse(text),object=v=>v&&typeof v==="object"&&!Array.isArray(v)
  const only=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k))
  if(!only(value,["format","version","draft","invalidInputs"])||value.format!=="omo-workbench"||value.version!==1)throw new Error("不是受支持的工作台备份")
  const d=value.draft
  if(!only(d,["recommendationsEnabled","recommendationVersion","roles","settings"])||!only(d.roles,ids)||ids.some(id=>!Object.hasOwn(d.roles,id))||!only(d.settings,["allowGlobalWrites","claudeGuardEnabled"]))throw new Error("备份字段不受支持")
  for(const id of ids){
    const r=d.roles[id]
    if(!only(r,acp(id)?["enabled","wrapperModel","requestedVariant","command","args","cwd","permissionMode","timeoutMs","behaviorEnv"]:["enabled","model","variant"]))throw new Error("角色字段不受支持")
    if(r.behaviorEnv!==undefined&&(id!=="claude"||!only(r.behaviorEnv,["CLAUDE_CODE_DISABLE_CLAUDE_MDS","CLAUDE_CODE_DISABLE_BUNDLED_SKILLS","CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"])))throw new Error("行为字段不受支持")
  }
  // Unfinished input is backup-only metadata, never a validated draft field.
  return clone(d)
}
export function differences(a,b,path=[]) {
  if(equal(a,b))return []
  if(a && b && typeof a==="object" && typeof b==="object" && !Array.isArray(a) && !Array.isArray(b))
    return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>differences(a[k],b[k],[...path,k]))
  return [{path,before:a,after:b}]
}
export function put(object,path,value) {
  let target=object
  for(const key of path.slice(0,-1))target=target[key]??={}
  if(value===undefined)delete target[path.at(-1)]
  else target[path.at(-1)]=clone(value)
}
// A serialized full-draft queue. Acknowledgements never replace in-memory edits.
// Stale revisions stop explicitly: no blind replacement of another editor's draft.
export function createDraftQueue(snapshot,send,onChange=()=>{},schedule=setTimeout,cancel=clearTimeout) {
  const state={memory:clone(snapshot.draft),saved:clone(snapshot.draft),revision:snapshot.revision,invalid:{},phase:"saved",conflict:null}
  let timer=null,inflight=null,retry=null,externalRetry=null,externalSend,externalRead
  const dirty=()=>!equal(state.memory,state.saved)||Object.keys(state.invalid).length>0
  function changed() {
    cancel(timer)
    if(inflight){onChange();return}
    if(state.phase==="failed"||state.phase==="conflict"){onChange();return}
    state.phase=Object.keys(state.invalid).length?"invalid":dirty()?"waiting":"saved"
    if(state.phase==="waiting")timer=schedule(flush,300)
    onChange()
  }
  async function flush() {
    if(inflight||externalRetry||Object.keys(state.invalid).length||state.phase==="conflict"||state.phase==="failed"||(!retry&&!dirty()))return
    const body=retry??{expectedRevision:state.revision,mutationId:crypto.randomUUID(),draft:clone(state.memory)}
    state.phase="saving";onChange()
    inflight=body
    try {
      const receipt=await send(body)
      state.saved=clone(receipt.replayed?body.draft:receipt.draft);state.revision=receipt.revision;retry=null;state.phase="saved"
    } catch(error) {
      state.error=error
      if(error.code==="STALE_REVISION"){state.phase="conflict";state.conflict=true;retry=null}
      else {state.phase="failed";retry=body}
    } finally {
      inflight=null;onChange()
      if(state.phase==="saved")changed()
    }
  }
  async function importDraft(sendImport,readLatest,candidate,resuming=false) {
    if(inflight||state.phase==="conflict"||retry||(state.phase==="failed"&&!resuming))throw new Error("请先处理草稿保存状态")
    cancel(timer)
    externalSend=sendImport;externalRead=readLatest
    const work=externalRetry??{body:{expectedRevision:state.revision,mutationId:crypto.randomUUID(),...(candidate===undefined?{confirm:true}:{draft:clone(candidate)})},before:clone(state.memory),invalid:clone(state.invalid)}
    externalRetry=work;inflight=work;state.phase="saving";onChange()
    try {
      let receipt=await sendImport(work.body)
      if(receipt.replayed){const latest=await readLatest();if(latest.revision!==receipt.revision)throw Object.assign(new Error("草稿已更新"),{code:"STALE_REVISION"});receipt=latest}
      const edits=differences(work.before,state.memory)
      state.memory=clone(receipt.draft)
      for(const change of edits)put(state.memory,change.path,change.after)
      for(const [key,value]of Object.entries(work.invalid))if(state.invalid[key]===value)delete state.invalid[key]
      state.saved=clone(receipt.draft);state.revision=receipt.revision;externalRetry=null;state.phase="saved"
    }catch(error){
      state.error=error
      if(["INVALID_VALUE","INVALID_REQUEST","TOO_LARGE"].includes(error.code)){externalRetry=null;state.phase="saved";throw error}
      state.phase=error.code==="STALE_REVISION"?"conflict":"failed"
    }
    finally{inflight=null;onChange();if(state.phase==="saved")changed()}
  }
  return {state,dirty,changed,flush,importDraft,retry:()=>{if(state.phase==="failed"){if(externalRetry)return importDraft(externalSend,externalRead,undefined,true);state.phase="waiting";return flush()}},
    // Explicit user action discards local edits only; no server overwrite.
    acceptLatest(snapshot){if(inflight)throw new Error("正在保存");cancel(timer);retry=null;externalRetry=null;state.memory=clone(snapshot.draft);state.saved=clone(snapshot.draft);state.revision=snapshot.revision;state.invalid={};state.conflict=null;state.phase="saved";onChange()},
    edit(path,value){put(state.memory,path,value);changed()}}
}
export const usablePreview = p => Boolean(p?.previewId && Number(p.expiresAt)>Date.now())
