import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { ACKNOWLEDGMENTS, VERSIONS, confirmations, request, usablePreview } from "../openchamber/panel/model.js"

test("explicit seven acknowledgments and exact operator-entered versions", () => {
  const all = Object.fromEntries(ACKNOWLEDGMENTS.map(([key]) => [key, true]))
  assert.equal(confirmations({}, VERSIONS), null)
  for (const [key] of ACKNOWLEDGMENTS) assert.equal(confirmations({...all, [key]:false}, VERSIONS), null)
  assert.equal(confirmations(all, {...VERSIONS, omo:"3.0.9"}), null)
  assert.equal(confirmations(all, {}), null)
  assert.deepEqual(confirmations(all, VERSIONS), {...all, versions:VERSIONS})
})
test("finite SDK service calls preserve ID-only write body and safe error codes", async () => {
  const calls = []
  const host = {async serviceRequest(payload) { calls.push(payload); return {status:200, body:{ok:true}} }}
  await request(host, "/status")
  await request(host, "/apply", {previewId:"server-created"})
  await request(host, "/recover", {confirmations:{fixture:true}})
  assert.deepEqual(calls, [{method:"GET",path:"/status"}, {method:"POST",path:"/apply",body:{previewId:"server-created"}}, {method:"POST",path:"/recover",body:{confirmations:{fixture:true}}}])
  await assert.rejects(request(host, "/arbitrary"), /INVALID_ROUTE/)
  await assert.rejects(request({serviceRequest:async()=>({status:409,body:JSON.stringify({ok:false,error:{code:"DRIFT",message:"changed"}})})}, "/apply", {previewId:"x"}), {code:"DRIFT"})
})
test("expired or malformed previews cannot proceed", () => {
  const preview = {previewId:"server-id",kind:"apply",expiresAt:new Date(2000).toISOString()}
  assert.equal(usablePreview(preview, 1000), true)
  assert.equal(usablePreview(preview, 2000), false)
  assert.equal(usablePreview({...preview, kind:"shell"}, 1000), false)
  assert.equal(usablePreview({...preview, expiresAt:"invalid"}, 1000), false)
  assert.equal(usablePreview(null), false)
})
test("panel is local, safely renders text, and has no preselected confirmations", async () => {
  const html = await readFile(new URL("../openchamber/panel/index.html", import.meta.url), "utf8")
  const app = await readFile(new URL("../openchamber/panel/app.js", import.meta.url), "utf8")
  assert.doesNotMatch(html, /(?:src|href)=["']https?:|checked(?:\s|>)/)
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|\.checked\s*=\s*true|postMessage|fetch\(/)
  assert.match(app, /textContent/)
  assert.match(app, /previewId: selected.previewId/)
  assert.match(html, /不是操作系统文件沙箱/)
  assert.match(html, /不是文本差异/)
  assert.match(html, /恢复将写入磁盘/)
  assert.match(app, /\$\("recover"\)\.addEventListener\("click"/)
  assert.match(app, /\["blocked", "recovery-required"\]\.includes\(status\?\.state\)/)
})
