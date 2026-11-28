import test from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import * as model from "../openchamber/panel/model.js"
import {createDiagnostics} from "../openchamber/panel/diagnostics.js"
const draft=()=>({recommendationsEnabled:true,recommendationVersion:"1",roles:Object.fromEntries(model.ids.map(id=>[id,{enabled:id!=="observer",...(model.acp(id)?{wrapperModel:"p/a/b",requestedVariant:"unknown",args:[],permissionMode:"ask"}:{model:"p/a/b",variant:"unknown"})}])),settings:{allowGlobalWrites:false,claudeGuardEnabled:false}})
const snapshot=()=>({revision:1,draft:draft(),appliedDraft:null,recommendations:{version:"1",roles:draft().roles},capabilities:{publish:true,hotApply:false,nativeImport:false},runtime:{state:"unknown"}})
function queue(send){const tasks=[];const q=model.createDraftQueue(snapshot(),send,()=>{},(fn,ms)=>{assert.equal(ms,300);tasks.push(fn);return tasks.length},()=>{});return {q,tasks}}
test("serialized autosave acknowledges sent draft, preserving edits made in flight",async()=>{
  let resolve;const sent=[]
  const {q}=queue(body=>{sent.push(body);return new Promise(r=>resolve=r)})
  q.edit(["roles","designer","model"],"p/first");const saving=q.flush()
  q.edit(["roles","oracle","model"],"p/newest")
  assert.equal(sent.length,1);resolve({revision:2,draft:sent[0].draft});await saving
  assert.equal(q.state.memory.roles.oracle.model,"p/newest")
  assert.equal(q.state.saved.roles.oracle.model,"p/a/b")
  const next=q.flush();assert.equal(sent[1].expectedRevision,2);resolve({revision:3,draft:sent[1].draft});await next
  assert.equal(q.dirty(),false)
})
test("lost reply retries identical mutation; replayed receipt has no draft and never erases edits",async()=>{
  let count=0;const sent=[]
  const {q}=queue(async body=>{sent.push(model.clone(body));if(!count++)throw Error("lost");return {revision:2,replayed:true}})
  q.edit(["roles","designer","variant"],"high");await q.flush()
  assert.equal(q.state.phase,"failed")
  q.edit(["roles","oracle","variant"],"new")
  await q.retry()
  assert.deepEqual(sent[0],sent[1]);assert.equal(q.state.memory.roles.oracle.variant,"new");assert.equal(q.state.saved.roles.oracle.variant,"unknown")
})
test("stale full replacement stops; explicit latest action discards without writing",async()=>{
  let calls=0
  const {q}=queue(async()=>{calls++;throw Object.assign(Error("stale"),{code:"STALE_REVISION"})})
  q.edit(["roles","designer","model"],"p/local");await q.flush()
  q.edit(["roles","oracle","model"],"p/retained");await q.flush()
  assert.equal(calls,1);assert.equal(q.state.phase,"conflict")
  const next=snapshot();next.revision=5;next.draft.roles.designer.model="p/remote"
  q.acceptLatest(next);assert.equal(calls,1);assert.equal(q.state.memory.roles.designer.model,"p/remote")
})
test("invalid inputs block autosave; opaque model IDs preserve all slashes",async()=>{
  let calls=0;const {q}=queue(async()=>{calls++})
  q.state.invalid["claude.args"]="[";q.changed();await q.flush()
  assert.equal(calls,0);assert.equal(q.dirty(),true)
  assert.equal(model.modelId({providerID:"magpie",id:"agy-cli/gemini-4-hydrogen"}),"magpie/agy-cli/gemini-4-hydrogen")
  q.edit(["recommendationsEnabled"],false);assert.equal(q.state.memory.roles.claude.requestedVariant,"unknown")
})
test("import serializes against autosave and preserves later edits; failed import retries same ID",async()=>{
  let resolve,calls=0;const sent=[]
  const {q}=queue(async()=>{throw Error("autosave must pause")})
  q.edit(["roles","designer","model"],"p/discard-confirmed")
  const send=body=>{sent.push(model.clone(body));calls++;return new Promise(r=>resolve=r)}
  const importing=q.importDraft(send,async()=>{})
  q.edit(["roles","oracle","model"],"p/later")
  await q.flush();assert.equal(calls,1)
  const imported=draft();imported.roles.designer.model="p/native"
  resolve({revision:2,draft:imported});await importing
  assert.equal(q.state.memory.roles.designer.model,"p/native")
  assert.equal(q.state.memory.roles.oracle.model,"p/later")
  const other=queue(async()=>{}).q
  let fail=true
  await other.importDraft(async body=>{sent.push(body);if(fail){fail=false;throw Error("lost")}return {revision:2,replayed:true}},async()=>({revision:2,draft:imported}))
  assert.equal(other.state.phase,"failed")
  await other.flush();assert.equal(sent.length,2)
  await other.retry();assert.deepEqual(sent[1],sent[2])
  assert.equal(other.state.memory.roles.designer.model,"p/native")
})
test("private JSON backup is bounded and allowlisted; backend rejection leaves draft untouched",async()=>{
  const backup={format:"omo-workbench",version:1,draft:draft(),invalidInputs:{"claude.args":"["}}
  assert.deepEqual(model.parseBackup(JSON.stringify(backup)),draft())
  assert.throws(()=>model.parseBackup(" ".repeat(60001)),/60 KB/)
  backup.draft.roles.designer.unmanaged="no"
  assert.throws(()=>model.parseBackup(JSON.stringify(backup)),/字段/)
  delete backup.draft.roles.designer.unmanaged
  const {q}=queue(async()=>{})
  const original=model.clone(q.state.memory)
  await assert.rejects(q.importDraft(async()=>{throw Object.assign(Error("invalid"),{code:"INVALID_VALUE"})},async()=>{},backup.draft),/invalid/)
  assert.deepEqual(q.state.memory,original);assert.equal(q.state.phase,"saved")
  let resolve,sent
  backup.draft.roles.designer.model="p/imported"
  const pending=q.importDraft(body=>{sent=body;return new Promise(r=>resolve=r)},async()=>{},backup.draft)
  q.edit(["roles","oracle","model"],"p/after-import")
  assert.equal(Object.hasOwn(sent,"confirm"),false)
  resolve({revision:2,draft:sent.draft});await pending
  assert.equal(q.state.memory.roles.oracle.model,"p/after-import")
  assert.equal(q.state.memory.roles.designer.model,"p/imported")
})

// Executes the actual app adapter with a small DOM and real state/request helpers.
// Not a visual/browser rendering claim.
class Element {
  constructor(tag="div"){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.value="";this.hidden=false;this.disabled=false}
  append(...nodes){this.children.push(...nodes)}
  replaceChildren(...nodes){this.children=nodes}
  setAttribute(k,v){this.attributes[k]=v}
  addEventListener(k,fn){this.listeners[k]=fn}
  focus(){this.focused=true}
  showModal(){this.open=true}
  close(){this.open=false;this.listeners.close?.()}
}
const descendants=n=>[n,...n.children.flatMap(c=>typeof c==="object"?descendants(c):[])]
async function appHarness(initial=snapshot(),extraConfirmations=[],patchReply,options={}){
  const html=await readFile(new URL("../openchamber/panel/index.html",import.meta.url),"utf8")
  const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]))
  const document={documentElement:new Element(),activeElement:new Element(),createElement:tag=>new Element(tag),createTextNode:text=>text,getElementById:id=>elements[id]||Object.values(elements).flatMap(descendants).find(n=>n.id===id)}
  const calls=[],storage=options.storage??new Map(),events={},timers=[]
  let directoryListener
  const host={onReady:fn=>fn({directory:Object.hasOwn(options,"directory")?options.directory:"/fixture/project"}),onDirectory:fn=>{directoryListener=fn},serviceRequest:async input=>{
    calls.push(input);let data
    if(input.path==="/workbench")data={ok:true,...initial}
    else if(input.path==="/workbench/draft"){const body=JSON.parse(input.body);data=patchReply?await patchReply(body):{ok:true,revision:2,draft:body.draft}}
    else if(input.path==="/workbench/import-native")data={ok:true,revision:2,draft:draft()}
    else if(input.path==="/workbench/preview")data={ok:true,mode:"publish",previewId:"preview",revision:2,diffDigest:"digest",expiresAt:Date.now()+60000,changes:[{field:"roles.designer.model",before:"p/old",after:"p/new",classification:"cold"}],risks:[],blockers:[],writeTarget:{targetId:"target",path:"/fixture/config/omo.json"},requiredConfirmations:extraConfirmations===null?[]:["nativeCandidateRoot","userConsent",...extraConfirmations]}
    else if(input.path==="/workbench/operations"){if(!options.operationReply)throw Error("lost");data=await options.operationReply(JSON.parse(input.body))}
    else if(input.path.startsWith("/workbench/operations/"))data=options.queryReply?await options.queryReply(input):{ok:true,operation:{operationId:input.path.split("/").at(-1),state:"applied",runtime:"pending"}}
    else {const directory=input.path==="/workbench/context"?JSON.parse(input.body).directory:new URLSearchParams(input.path.split("?")[1]).get("directory");data=options.catalogReply?await options.catalogReply(input,directory):{ok:true,models:[{providerID:"p",id:"a/b",variants:["medium"]}],status:"live",catalogContext:{requestedDirectory:directory}}}
    return {status:data.ok===false?(data.error.code==="NOT_FOUND"?404:409):200,body:JSON.stringify(data)}
  }}
  const deps={...model,connectHost:()=>host,applyHostReady:()=>{},createDiagnostics,document,window:{addEventListener:(name,fn)=>events[name]=fn,location:{reload(){}}},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setInterval:()=>{},setTimeout:(fn)=>{timers.push(fn);return timers.length},clearTimeout:()=>{}}
  const source=(await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")).replace(/^import .*$/gm,"")
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
  await new AsyncFunction(...Object.keys(deps),source)(...Object.values(deps))
  await Promise.resolve()
  return {elements,document,calls,events,timers,storage,emitDirectory:directory=>directoryListener(directory)}
}
test("actual DOM handlers retain invalid role input through navigation and warn on unload",async()=>{
  const {elements,document,calls,events}=await appHarness()
  assert.equal(elements.list.children.length,12)
  elements.list.children.find(n=>n.dataset.role==="claude").onclick()
  const args=descendants(elements.detail).find(n=>n.tagName==="label"&&n.textContent==="参数（JSON 数组）").children[0]
  args.value="[";args.oninput()
  elements.list.children.find(n=>n.dataset.role==="designer").onclick()
  elements.list.children.find(n=>n.dataset.role==="claude").onclick()
  const restored=descendants(elements.detail).find(n=>n.tagName==="label"&&n.textContent==="参数（JSON 数组）").children[0]
  assert.equal(restored.value,"[")
  let prevented=false;events.beforeunload({preventDefault(){prevented=true}})
  assert.equal(prevented,true)
  assert.equal(calls.filter(c=>c.path==="/workbench/draft").length,0)
  assert.deepEqual(JSON.parse(calls.find(c=>c.path==="/workbench/context").body),{directory:"/fixture/project"})
  assert.ok(document.getElementById("role-title"))
})
test("actual preview is side-effect free; exact root confirmations gate publication and lost reply queries",async()=>{
  const {elements,calls,storage}=await appHarness()
  await elements.publish.onclick()
  assert.equal(calls.filter(c=>c.path==="/workbench/draft").length,0)
  assert.equal(elements.confirm.disabled,true)
  const checks=descendants(elements.risk).filter(n=>n.tagName==="input")
  for(const input of checks){input.checked=true;input.onchange()}
  assert.equal(elements.confirm.disabled,false)
  await elements.confirm.onclick()
  const body=JSON.parse(calls.find(c=>c.path==="/workbench/operations").body)
  assert.equal(body.targetId,"target");assert.deepEqual(body.confirmations,["nativeCandidateRoot","userConsent"])
  assert.equal(storage.size,1);assert.equal(elements.publish.disabled,true)
  await descendants(elements.banner).find(n=>n.tagName==="button"&&n.textContent==="查询状态").onclick()
  assert.equal(calls.filter(c=>c.path==="/workbench/operations").length,1)
  assert.equal(storage.size,0);assert.equal(elements.reload.hidden,false)
})
test("actual recommendation upgrade retains custom fields; unknown historical base is manual-only",async()=>{
  const initial=snapshot()
  initial.recommendationUpdate={available:true}
  initial.recommendationBase={version:"1",roles:draft().roles}
  initial.recommendations={version:"2",roles:draft().roles}
  initial.recommendations.roles.designer.model="p/new-recommendation"
  initial.recommendations.roles.oracle.model="p/new-oracle"
  initial.draft.roles.oracle.model="p/custom"
  const {elements}=await appHarness(initial)
  descendants(elements["settings-view"]).find(n=>n.textContent==="更新内置推荐").onclick()
  await elements["data-confirm"].onclick()
  assert.match(elements.list.children.find(n=>n.dataset.role==="designer").children[1].textContent,/p\/new-recommendation/)
  assert.match(elements.list.children.find(n=>n.dataset.role==="oracle").children[1].textContent,/p\/custom/)
  initial.recommendationBase=null
  const manual=await appHarness(initial)
  assert.equal(descendants(manual.elements["settings-view"]).some(n=>n.textContent==="更新内置推荐"),false)
  assert.ok(descendants(manual.elements["settings-view"]).some(n=>n.textContent?.includes("旧版基线不可确认")))
})
test("actual backup dialog rejects malformed input and imports only draft through string PATCH",async()=>{
  const {elements,calls}=await appHarness()
  elements["import-text"].value="{"
  elements["import-confirm"].onclick()
  assert.ok(elements["import-error"].textContent)
  assert.equal(calls.some(c=>c.method==="PATCH"),false)
  const imported=draft();imported.roles.designer.model="p/backup"
  elements["import-text"].value=JSON.stringify({format:"omo-workbench",version:1,draft:imported,invalidInputs:{"claude.args":"["}})
  elements["import-confirm"].onclick()
  await elements["data-confirm"].onclick()
  const body=JSON.parse(calls.find(c=>c.method==="PATCH").body)
  assert.deepEqual(body.draft,imported)
  assert.equal(Object.hasOwn(body,"invalidInputs"),false)
  assert.equal(calls.some(c=>c.path==="/workbench/operations"),false)
})
test("external overwrite preview offers same-screen native import and never publishes",async()=>{
  const initial=snapshot();initial.capabilities.nativeImport=true
  const {elements,calls}=await appHarness(initial,["externalOverwrite"])
  await elements.publish.onclick()
  descendants(elements.risk).find(n=>n.textContent==="导入外部修改").onclick()
  await elements["data-confirm"].onclick()
  assert.equal(elements.review.open,false)
  assert.equal(calls.filter(c=>c.path==="/workbench/import-native").length,1)
  assert.equal(calls.some(c=>c.path==="/workbench/operations"),false)
})
test("authorized risk-free publish has no checkboxes but still requires explicit confirm",async()=>{
  const {elements,calls}=await appHarness(snapshot(),null)
  await elements.publish.onclick()
  assert.equal(descendants(elements.risk).filter(n=>n.tagName==="input").length,0)
  assert.equal(elements.confirm.disabled,false)
  assert.equal(calls.some(c=>c.path==="/workbench/operations"),false)
  await elements.confirm.onclick()
  assert.deepEqual(JSON.parse(calls.find(c=>c.path==="/workbench/operations").body).confirmations,[])
})
test("actual backup rejection retains memory and edits during accepted import survive",async()=>{
  const backup={format:"omo-workbench",version:1,draft:draft()}
  backup.draft.roles.designer.model="p/imported"
  const rejected=await appHarness(snapshot(),[],()=>({ok:false,error:{code:"INVALID_VALUE",reason:"invalid backup"}}))
  rejected.elements["import-text"].value=JSON.stringify(backup)
  rejected.elements["import-confirm"].onclick()
  await rejected.elements["data-confirm"].onclick()
  assert.match(rejected.elements["import-error"].textContent,/invalid backup/)
  descendants(rejected.elements["settings-view"]).find(n=>n.textContent==="导出配置").onclick()
  assert.equal(JSON.parse(rejected.elements["data-text"].textContent).draft.roles.designer.model,"p/a/b")
  let resolve
  const accepted=await appHarness(snapshot(),[],body=>new Promise(r=>resolve=()=>r({ok:true,revision:2,draft:body.draft})))
  accepted.elements["import-text"].value=JSON.stringify(backup)
  accepted.elements["import-confirm"].onclick()
  const pending=accepted.elements["data-confirm"].onclick()
  accepted.elements.list.children.find(n=>n.dataset.role==="claude").onclick()
  const args=descendants(accepted.elements.detail).find(n=>n.tagName==="label"&&n.textContent==="参数（JSON 数组）").children[0]
  args.value='["later"]';args.oninput()
  resolve();await pending
  descendants(accepted.elements["settings-view"]).find(n=>n.textContent==="导出配置").onclick()
  const saved=JSON.parse(accepted.elements["data-text"].textContent).draft
  assert.equal(saved.roles.designer.model,"p/imported")
  assert.deepEqual(saved.roles.claude.args,["later"])
})
test("independent pages request their own catalog; late context and mismatched responses are rejected",async()=>{
  const pending=[]
  const envelope=(directory,id)=>({ok:true,models:[{providerID:"fixture",id,variants:[]}],status:"live",catalogContext:{requestedDirectory:directory}})
  const a=await appHarness(snapshot(),[],undefined,{directory:"/A",catalogReply:(input,directory)=>new Promise(resolve=>pending.push({input,directory,resolve}))})
  const b=await appHarness(snapshot(),[],undefined,{directory:"/B"})
  assert.ok(b.calls.some(c=>c.path==="/models?directory=%2FB"))
  a.emitDirectory("/B")
  pending.find(p=>p.directory==="/B").resolve(envelope("/B","new"))
  await new Promise(resolve=>setImmediate(resolve))
  for(const item of pending.filter(p=>p.directory==="/A"))item.resolve(envelope("/A","old"))
  await new Promise(resolve=>setImmediate(resolve))
  assert.ok(a.elements.options.children.some(n=>n.textContent?.includes("fixture/new")))
  assert.equal(a.elements.options.children.some(n=>n.textContent?.includes("fixture/old")),false)
  const refreshing=a.elements.refresh.onclick()
  pending.at(-1).resolve(envelope("/A","wrong"))
  await refreshing
  assert.equal(a.elements.options.children.some(n=>n.textContent?.includes("fixture/wrong")),false)
  assert.equal(a.elements.list.children[0].children[1].textContent,"p/a/b")
  a.emitDirectory(null)
  assert.equal(a.elements.options.children.some(n=>n.textContent?.includes("fixture/new")),false)
  const noContext=await appHarness(snapshot(),[],undefined,{directory:null})
  assert.ok(noContext.calls.some(c=>c.path==="/models"))
  assert.equal(noContext.calls.some(c=>c.path.includes("directory=")||c.path==="/workbench/context"),false)
})
test("proven pre-WAL rejection releases only its handle and retains later draft edits across reload",async()=>{
  let rejectOperation
  const app=await appHarness(snapshot(),null,undefined,{operationReply:()=>new Promise(resolve=>rejectOperation=()=>resolve({ok:false,error:{code:"STALE_PREVIEW",disposition:{operationStarted:false}}}))})
  await app.elements.publish.onclick()
  const publishing=app.elements.confirm.onclick()
  app.elements.list.children.find(n=>n.dataset.role==="claude").onclick()
  const args=descendants(app.elements.detail).find(n=>n.tagName==="label"&&n.textContent==="参数（JSON 数组）").children[0]
  args.value='["newer"]';args.oninput()
  rejectOperation();await publishing
  assert.equal(app.storage.size,0)
  assert.match(app.elements.banner.children[0],/未提交发布/)
  descendants(app.elements["settings-view"]).find(n=>n.textContent==="导出配置").onclick()
  assert.deepEqual(JSON.parse(app.elements["data-text"].textContent).draft.roles.claude.args,["newer"])
  const reloaded=await appHarness(snapshot(),null,undefined,{storage:app.storage})
  assert.equal(reloaded.elements.publish.disabled,false)
  await reloaded.elements.publish.onclick()
  assert.equal(reloaded.elements.review.open,true)
})
test("unknown result and query404 retain durable handle and repeatable query after reload",async()=>{
  const app=await appHarness(snapshot(),null)
  await app.elements.publish.onclick();await app.elements.confirm.onclick()
  const reloaded=await appHarness(snapshot(),null,undefined,{storage:app.storage,queryReply:()=>({ok:false,error:{code:"NOT_FOUND",disposition:{operationStarted:false}}})})
  await descendants(reloaded.elements.banner).find(n=>n.textContent==="查询状态").onclick()
  assert.equal(reloaded.storage.size,1)
  assert.equal(reloaded.elements.publish.disabled,true)
  assert.ok(descendants(reloaded.elements.banner).find(n=>n.textContent==="查询状态"))
  assert.equal(reloaded.calls.some(c=>c.path==="/workbench/operations"),false)
})
test("only explicit no-WAL proof unlocks repreview; unproven conflicts stay query-only",async()=>{
  const proven=await appHarness(snapshot(),null,undefined,{operationReply:()=>({ok:false,error:{code:"CONFLICT",disposition:{operationStarted:false}}})})
  await proven.elements.publish.onclick();await proven.elements.confirm.onclick()
  assert.equal(proven.elements.publish.disabled,false)
  await proven.elements.publish.onclick()
  assert.equal(proven.calls.filter(c=>c.path==="/workbench/preview").length,2)
  assert.equal(proven.calls.filter(c=>c.path==="/workbench/operations").length,1)
  const unknown=await appHarness(snapshot(),null,undefined,{operationReply:()=>({ok:false,error:{code:"CONFLICT"}})})
  await unknown.elements.publish.onclick();await unknown.elements.confirm.onclick()
  assert.equal(unknown.elements.publish.disabled,true)
  assert.equal(unknown.storage.size,1)
  assert.ok(descendants(unknown.elements.banner).find(n=>n.textContent==="查询状态"))
})
test("late proven rejection never deletes a replacement persisted operation handle",async()=>{
  let finish
  const app=await appHarness(snapshot(),null,undefined,{operationReply:()=>new Promise(resolve=>finish=()=>resolve({ok:false,error:{code:"CONFLICT",disposition:{operationStarted:false}}}))})
  await app.elements.publish.onclick();const pending=app.elements.confirm.onclick()
  const key=[...app.storage.keys()][0]
  app.storage.set(key,JSON.stringify({operationId:"newer-operation"}))
  finish();await pending
  assert.equal(JSON.parse(app.storage.get(key)).operationId,"newer-operation")
})
