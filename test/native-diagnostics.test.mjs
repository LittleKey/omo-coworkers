import test from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {createDiagnostics} from "../openchamber/panel/diagnostics.js"
import {request} from "../openchamber/panel/model.js"

test("finite metadata rejects arbitrary secrets and bounds memory",()=>{
  const d=createDiagnostics()
  for(let i=0;i<105;i++)d.add("request-error",{path:"/config?secret=SECRET",method:"SECRET",errorCode:"SECRET",bodyType:"SECRET",body:"SECRET",message:"SECRET",stack:"SECRET",status:"SECRET",request:i+1})
  const text=d.export(),events=JSON.parse(text)
  assert.equal(events.length,100);assert.equal(events[0].sequence,6)
  assert(!text.includes("SECRET"));assert.equal(events[0].errorCode,"UNKNOWN")
  assert.equal(events[0].path,undefined)
  assert(events.every((e,i)=>!i||e.elapsedMs>=events[i-1].elapsedMs))
  d.add("SECRET");assert.equal(JSON.parse(d.export()).length,100)
  d.clear();assert.deepEqual(JSON.parse(d.export()),[])
})
test("helper wire boundary logs serialized type/bytes, settlement and sanitized errors",async()=>{
  const d=createDiagnostics();let release
  const host={serviceRequest:input=>{assert.equal(typeof input.body,"string");return new Promise(r=>release=r)}}
   const pending=request({serviceRequest:i=>d.serviceRequest(host,i)},"POST","/workbench/preview",{secret:"SECRET"})
  assert.deepEqual(JSON.parse(d.export()).map(e=>e.stage),["request-send"])
  release({status:200,body:{ok:true,secret:"SECRET"}});await pending
  let events=JSON.parse(d.export())
  assert.equal(events[0].bodyType,"string");assert.equal(events[0].byteCount,19)
  assert.equal(events[1].stage,"service-response");assert.equal(events[1].status,200)
  assert.equal(events[1].request,events[0].request)
  await assert.rejects(d.serviceRequest({serviceRequest:async()=>{throw Object.assign(Error("SECRET"),{code:"HOST_TIMEOUT",stack:"SECRET"})}},{method:"GET",path:"/snapshot"}))
  events=JSON.parse(d.export());assert.equal(events.at(-1).errorCode,"HOST_TIMEOUT")
  assert(!d.export().includes("SECRET"))
})
test("UI diagnostic collection defaults off and never disables editing during publication",async()=>{
  const app=await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  const html=await readFile(new URL("../openchamber/panel/index.html",import.meta.url),"utf8")
   assert.match(app,/trace\.serviceRequest\(host,input\)/)
   assert.match(app,/logs=false/)
   assert.match(app,/1800000/)
   assert.match(html,/<dialog id="data-dialog"/)
   assert.doesNotMatch(app,/\.inert=/)
})
