import test from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {request,roleIntent,hasChanges,usablePreview,changeSummary} from "../openchamber/panel/model.js"
const role={id:"document-role",settings:{enabled:true,model:{value:"p/old",editable:true},variant:{value:"unknown-current",editable:true}}}
test("finite capability API excludes retired arbitrary editing",async()=>{
  const calls=[],host={serviceRequest:async v=>{calls.push(v);return {status:200,body:{ok:true}}}}
  await request(host,"GET","/models");await request(host,"POST","/intent-preview",{revision:"r",intent:{kind:"role-settings",capabilityId:"document-role",enabled:false}})
  for(const path of ["/preview","/reveal","/template-preview","/user-templates"])await assert.rejects(request(host,"POST",path,{}),/INVALID_ROUTE/)
  assert.equal(calls.length,2)
  assert.equal(Object.hasOwn(calls[0],"body"),false)
  assert.equal(typeof calls[1].body,"string")
  assert.deepEqual(JSON.parse(calls[1].body),{revision:"r",intent:{kind:"role-settings",capabilityId:"document-role",enabled:false}})
})
test("all mutation routes serialize once and enforce the wire byte limit",async()=>{
  const calls=[],host={serviceRequest:async value=>{
    assert.equal(typeof value.body,"string","host service-request schema requires a string body")
    calls.push(value)
    return {status:200,body:'{"ok":true}'}
  }}
  for(const [method,path] of [["POST","/intent-preview"],["PATCH","/config"],["PATCH","/settings"],["POST","/undo-preview"],["POST","/recover"],["POST","/migration-preview"]]){
    const body={text:'中文 "quoted"',enabled:false,optional:null}
    await request(host,method,path,body)
    assert.deepEqual(JSON.parse(calls.at(-1).body),body)
  }
  await request(host,"POST","/recover",null)
  assert.equal(calls.at(-1).body,"null")
  const count=calls.length
  await assert.rejects(request(host,"POST","/intent-preview",{text:"中".repeat(21000)}),/请求过大/)
  assert.equal(calls.length,count)
})
test("unknown variant preserved; model changes require explicit variant decision",()=>{
  const draft={enabled:true,model:"p/old",variant:"unknown-current",variantChosen:false}
  assert.equal(hasChanges(role,draft),false)
  assert.deepEqual(roleIntent(role,{...draft,enabled:false}),{kind:"role-settings",capabilityId:"document-role",enabled:false})
  assert.throws(()=>roleIntent(role,{...draft,model:"p/new"}),/明确选择/)
  assert.deepEqual(roleIntent(role,{...draft,model:"p/new",variant:null,variantChosen:true}),{kind:"role-settings",capabilityId:"document-role",model:"p/new",variant:null})
  assert.throws(()=>roleIntent({...role,settings:{...role.settings,model:{...role.settings.model,editable:false}}},{...draft,model:"p/new",variantChosen:true}),/不支持/)
})
test("server expiry required",()=>{
  assert.equal(usablePreview({previewId:"p"}),false)
  assert.equal(usablePreview({previewId:"p",expiresAt:new Date(Date.now()+60000).toISOString()}),true)
})
test("commit readback excludes catalog and timeout requires explicit readback",async()=>{
  const app=await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  const refresh=app.slice(app.indexOf("async function refresh(preserve"),app.indexOf("function requireClean"))
  assert.doesNotMatch(refresh,/\/models|Promise.allSettled/)
  assert.match(app,/commitUnknown=true;needsReadback=true;invalidate\(\)/)
  assert.match(app,/epoch!==catalogEpoch/)
  assert.match(app,/已保存到磁盘，但状态刷新失败/)
  assert.match(app,/if\(writing\|\|reading\)return/)
  assert.match(app,/if\(reading\|\|\(writing&&!internal\)\)return/)
})
test("role baseline intent merges unrelated changes and rejects dependent conflicts",()=>{
  const draft={enabled:true,model:"p/new",variant:null,variantChosen:true}
  const disabled=structuredClone(role);disabled.settings.enabled=false
  assert.equal(Object.hasOwn(roleIntent(role,draft,disabled),"enabled"),false)
  const changed=structuredClone(role);changed.settings.model.value="p/external"
  assert.deepEqual(roleIntent(role,{enabled:false,model:"p/old",variantChosen:false},changed),{kind:"role-settings",capabilityId:"document-role",enabled:false})
  assert.throws(()=>roleIntent(role,draft,changed),/外部已修改/)
  assert.throws(()=>roleIntent(role,{enabled:true,model:"p/old",variant:"high",variantChosen:true},changed),/外部已修改/)
})
test("ACP entry preview uses only finite public runtime summary",()=>{
  const text=changeSummary({entrySummary:{action:"delete",agentId:"claude",runtime:{command:"claude-agent-acp",args:[],timeoutMs:0,permissionMode:"ask",env:"SECRET"}}})
  assert.match(text,/删除 ACP 代理 claude/)
  assert.match(text,/可执行程序/)
  assert.doesNotMatch(text,/SECRET/)
})
test("dirty draft comparison survives unavailable snapshot through valid baseline",async()=>{
  const baseline=structuredClone(role),draft={enabled:false,model:"p/old",variant:"unknown-current",variantChosen:false}
  assert.equal(hasChanges(baseline,draft),true)
  const unavailable={id:role.id}
  assert.equal(unavailable.settings,undefined)
  assert.equal(hasChanges(baseline,draft),true)
  const app=await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  assert.match(app,/hasChanges\(draftBaseline,draft\)/)
  assert.match(app,/renderOpen\(selected,preserve&&wasDirty\)/)
  assert.match(app,/if\(!preserveDraft\)/)
})
test("official SDK theme and searchable picker use narrow ACP fields",async()=>{
  const app=await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  const theme=await readFile(new URL("../openchamber/panel/vendor/theme.js",import.meta.url),"utf8")
  assert.match(app,/onReady\?\.\(context=>applyHostReady/)
  assert.match(theme,/\['--oc-bg', 'background'\]/)
  assert.match(app,/role","combobox"/)
  assert.match(app,/kind:"acp-settings"/)
  assert.match(app,/kind:"acp-create"/)
  assert.doesNotMatch(app,/env:\s*draft|shell:\s*true/)
  assert.match(app,/behaviorEnv/)
  for(const key of ["CLAUDE_CODE_DISABLE_CLAUDE_MDS","CLAUDE_CODE_DISABLE_BUNDLED_SKILLS","CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"])assert.match(app,new RegExp(key))
  assert.match(app,/select.value==="inherit"\?null:select.value/)
  assert.match(app,/risk==="behavior-change"/)
})
test("readonly model also blocks variant; membership wording follows disabled membership",()=>{
  assert.throws(()=>roleIntent({...role,settings:{...role.settings,model:{...role.settings.model,editable:false}}},{enabled:true,model:"p/old",variant:null,variantChosen:true}),/不支持/)
  assert.equal(changeSummary({field:["disabled_agents","document-writer"],before:false,after:true}),"启用 → 停用")
  assert.equal(changeSummary({field:["disabled_agents","document-writer"],before:true,after:false}),"停用 → 启用")
})
test("one adaptive DOM, narrow controls, no old editor or generic API",async()=>{
  const html=await readFile(new URL("../openchamber/panel/index.html",import.meta.url),"utf8")
  const app=await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  const css=await readFile(new URL("../openchamber/panel/panel.css",import.meta.url),"utf8")
  assert.doesNotMatch(app,/innerHTML|postMessage|localStorage|\/reveal|\/user-templates|document\.querySelector\("main"\)\.inert/)
  assert.doesNotMatch(html,/data-view|view-templates|新字段/)
  const textareas=html.match(/<textarea\b[^>]*>/g)||[]
  assert.equal(textareas.length,1)
  assert.match(textareas[0],/\bid="trace-output"/)
  assert.match(textareas[0],/\breadonly(?:\s|>)/)
  assert.match(css,/@container/);assert.match(css,/--oc-/);assert.match(css,/safe-area-inset/);assert.match(css,/min-height:44px/)
  assert.match(app,/variantChosen=false/);assert.match(app,/confirmInlineReplacement:true/)
})
