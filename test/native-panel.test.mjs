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
test("dirty draft comparison survives unavailable snapshot through valid baseline",async()=>{
  const baseline=structuredClone(role),draft={enabled:false,model:"p/old",variant:"unknown-current",variantChosen:false}
  assert.equal(hasChanges(baseline,draft),true)
  const unavailable={id:role.id}
  assert.equal(unavailable.settings,undefined)
  assert.equal(hasChanges(baseline,draft),true)
  const app=await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  assert.match(app,/const dirty=\(\)=>hasChanges\(draftBaseline,draft\)/)
  assert.match(app,/renderOpen\(selected,preserve&&wasDirty\)/)
  assert.match(app,/if\(!preserveDraft\)/)
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
  assert.doesNotMatch(html,/data-view|view-templates|新字段|textarea/)
  assert.match(css,/@container/);assert.match(css,/--oc-/);assert.match(css,/safe-area-inset/);assert.match(css,/min-height:44px/)
  assert.match(app,/variantChosen=false/);assert.match(app,/confirmInlineReplacement:true/)
})
