import test from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {request,usablePreview,catalogPath} from "../openchamber/panel/model.js"

test("only finite workbench routes cross the bridge; retired generic writers never do",async()=>{
  const calls=[],host={serviceRequest:async input=>{calls.push(input);return {status:200,body:'{"ok":true}'}}}
  await request(host,"GET","/workbench")
  for(const path of ["/config","/settings","/intent-preview","/undo-preview","/recover","/migration-preview","/preview","/templates"])await assert.rejects(request(host,"POST",path,{}),/INVALID_ROUTE/)
  assert.equal(calls.length,1);assert.equal(Object.hasOwn(calls[0],"body"),false)
})
test("all mutation routes serialize whole JSON exactly once at SDK boundary and enforce bytes",async()=>{
  const calls=[],host={serviceRequest:async input=>{calls.push(input);assert.equal(typeof input.body,"string");return {status:200,body:{ok:true}}}}
  for(const [method,path]of [["PATCH","/workbench/draft"],["POST","/workbench/import-native"],["POST","/workbench/context"],["POST","/workbench/preview"],["POST","/workbench/operations"]]){
    const body={text:'中文 "quoted"',enabled:false,optional:null}
    await request(host,method,path,body);assert.deepEqual(JSON.parse(calls.at(-1).body),body)
  }
  await assert.rejects(request(host,"PATCH","/workbench/draft",{text:"中".repeat(21000)}),/请求过大/)
  assert.equal(calls.length,5)
})
test("server numeric expiry and safe operation lookup only",async()=>{
  assert.equal(usablePreview({previewId:"p"}),false)
  assert.equal(usablePreview({previewId:"p",expiresAt:Date.now()+60000}),true)
  const host={serviceRequest:async()=>({status:200,body:{ok:true}})}
  await request(host,"GET","/workbench/operations/id-1")
  await assert.rejects(request(host,"GET","/workbench/operations/../config"),/INVALID_ROUTE/)
})
test("sanitized adoption diagnostic context survives the request boundary",async()=>{
  const host={serviceRequest:async()=>({status:409,body:{ok:false,error:{code:"PERSONAL_CONTENT_BLOCKED",reason:"个人内容不会覆盖",field:"agents.oracle.prompt",resource:"prompts/oracle.md",nextAction:"请人工核对"}}})}
  await assert.rejects(request(host,"POST","/workbench/preview",{revision:1,mode:"publish"}),e=>e.code==="PERSONAL_CONTENT_BLOCKED"&&e.field==="agents.oracle.prompt"&&e.resource==="prompts/oracle.md")
})
test("catalog requests encode one bounded request directory and reject unknown/duplicate queries",async()=>{
  const calls=[],host={serviceRequest:async input=>{calls.push(input);return {status:200,body:{ok:true}}}}
  const path=catalogPath("/fixture/A & B/模型",true)
  await request(host,"GET",path)
  assert.equal(new URLSearchParams(path.split("?")[1]).get("directory"),"/fixture/A & B/模型")
  for(const invalid of ["/models?directory=%ZZ","/models?directory=/a&directory=/b","/models?directory=/a&refresh=true&refresh=true","/models?secret=x","/models?directory=relative","/models?directory="+encodeURIComponent("/"+"a".repeat(4096))])await assert.rejects(request(host,"GET",invalid),/INVALID_ROUTE/)
  assert.equal(calls.length,1)
})
test("operation not-started marker is accepted only on operation POST rejection",async()=>{
  const host={serviceRequest:async()=>({status:409,body:{ok:false,error:{code:"CONFLICT",disposition:{operationStarted:false,ignored:"no"}}}})}
  await assert.rejects(request(host,"POST","/workbench/operations",{}),e=>e.disposition?.operationStarted===false&&Object.keys(e.disposition).length===1)
  await assert.rejects(request(host,"GET","/workbench/operations/abcdefgh"),e=>e.disposition===undefined)
})
test("adaptive shell keeps native dialogs, actual SDK theme and safe area controls",async()=>{
  const [html,css,app]=await Promise.all(["index.html","panel.css","app.js"].map(f=>readFile(new URL(`../openchamber/panel/${f}`,import.meta.url),"utf8")))
  assert.equal((html.match(/id="tab-/g)||[]).length,2)
  assert.match(html,/<dialog id="picker"/);assert.match(html,/type="module"/)
  assert.match(css,/min-height:44px/);assert.match(css,/font-size:16px/);assert.match(css,/safe-area-inset-bottom/);assert.match(css,/max-width:559px/)
  assert.match(app,/applyHostReady\(context,document.documentElement\)/)
  assert.match(app,/selectContext\(context.directory\)/)
  assert.doesNotMatch(app,/\/intent-preview|\/config"|kind:"role-settings"|\.inert=/)
})
