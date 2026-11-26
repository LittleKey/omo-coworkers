import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { request, safeOperations, containsProtected, parseValue, usablePreview, fieldControl, assertDraftCompatible } from "../openchamber/panel/model.js"
import { classification } from "../openchamber/native-config/manager.mjs"
test("one draft gate blocks incompatible mutation intents but preserves edit workflow", () => {
  for (const [method,path] of [["POST","/user-templates"],["DELETE","/user-templates"],["POST","/undo-preview"],["POST","/migration-preview"],["POST","/template-preview"],["POST","/recover"],["PATCH","/settings"]]) {
    assert.throws(()=>assertDraftCompatible(method,path,true), {code:"UNSAVED_DRAFT"})
    assert.doesNotThrow(()=>assertDraftCompatible(method,path,false))
  }
  for (const [method,path] of [["GET","/snapshot"],["POST","/reveal"],["POST","/preview"],["PATCH","/config"]]) assert.doesNotThrow(()=>assertDraftCompatible(method,path,true))
})

test("ACP controls match bundled native schema and manager editable fields", async () => {
  const schema = JSON.parse(await readFile(new URL("../openchamber/native-config/schema/omo-3.0.8.json", import.meta.url), "utf8"))
  const acp = schema.properties.acpAgents.additionalProperties.properties
  assert.deepEqual(fieldControl(["acpAgents","claude","permissionMode"]).options, acp.permissionMode.enum)
  const timeout = fieldControl(["acpAgents","claude","timeoutMs"])
  assert.deepEqual(timeout, {type:"number",min:acp.timeoutMs.minimum,max:acp.timeoutMs.maximum,step:1})
  for (const mode of ["ask","allow","reject"]) assert.equal(classification(["acpAgents","claude","permissionMode"],mode),"ordinary")
  assert.equal(classification(["acpAgents","claude","timeoutMs"],120000),"ordinary")
  for (const path of [["defaultAgent"],["notifications"],["acpAgents","claude","timeout"]]) {
    assert.equal(fieldControl(path),null)
    assert.equal(classification(path,120),"protected")
  }
  const app = await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  assert.match(app,/fieldControl\(field\.path\)/)
  assert.match(app,/control\.options/)
  assert.match(app,/input\.setAttribute\("aria-label", `\$\{resource\.id\} \$\{field\.path\.join/)
  assert.doesNotMatch(app,/defaultAgent|notifications|["']timeout["']/)
})

test("manager uses only finite authenticated host routes and small requests", async () => {
  const calls = [], host = { serviceRequest: async input => { calls.push(input); return { status: 200, body: { ok: true } } } }
  await request(host, "GET", "/snapshot")
  await request(host, "PATCH", "/config", { previewId: "server-id" })
  await request(host, "POST", "/recover", { confirm: true })
  await request(host, "PATCH", "/settings", { revision: "revision", claudeGuardEnabled: true, confirmEnable: true })
  assert.deepEqual(calls[1], { method: "PATCH", path: "/config", body: { previewId: "server-id" } })
  await assert.rejects(request(host, "POST", "/shell", {}), /INVALID_ROUTE/)
  await assert.rejects(request(host, "POST", "/preview", { text: "中".repeat(22000) }), { code: "BODY_TOO_LARGE" })
})
test("small operations cannot serialize protected projections", () => {
  assert.equal(containsProtected({ agents: { secret: { protected: true, placeholder: "ref" } } }), true)
  assert.throws(() => safeOperations([{resourceId:"config",field:["agents"],action:"set",value:{secret:{protected:true}}}]), /占位/)
  assert.throws(() => safeOperations(Array.from({length:33}, () => ({resourceId:"config",field:["model"],action:"delete"}))), /32/)
  assert.deepEqual(safeOperations([{resourceId:"config",field:["agents","oracle","model"],action:"set",value:"test/model",path:"/forbidden"}]), [{resourceId:"config",field:["agents","oracle","model"],action:"set",value:"test/model"}])
  assert.equal(parseValue("model/name", "old"), "model/name")
  assert.deepEqual(parseValue('["mcp"]', []), ["mcp"])
})
test("structured safe errors preserve field conflict and next action", async () => {
  const host = { serviceRequest: async () => ({ status:409, body:{ok:false,error:{code:"CONFLICT",resource:"config",field:["agents","oracle","model"],reason:"字段已改变",nextAction:"重新读取"},conflicts:[{resourceId:"config",field:["agents","oracle","model"]}]}}) }
  await assert.rejects(request(host,"PATCH","/config",{previewId:"p"}), e => e.code === "CONFLICT" && e.conflicts[0].field[2] === "model" && e.nextAction === "重新读取")
})
test("preview lifetime enforced locally without runtime claims", () => {
  assert.equal(usablePreview({previewId:"p",changes:[],expiresAt:new Date(300100).toISOString()},300101),false)
  assert.equal(usablePreview({previewId:"p",changes:[],expiresAt:new Date(300100).toISOString()},101),true)
  assert.equal(usablePreview({previewId:"p",changes:[],receivedAt:100},101),false)
  assert.equal(usablePreview({previewId:"p"}),false)
})
test("recipe intents preview first; old direct undo and ownership actions absent", async () => {
  const calls = [], host = {serviceRequest: async input => { calls.push(input); return {status:200,body:{ok:true}} }}
  await request(host,"POST","/undo-preview",{transactionId:"server-id"})
  await request(host,"POST","/migration-preview",{confirmOldWriterStopped:true})
  await assert.rejects(request(host,"POST","/undo",{transactionId:"server-id"}), /INVALID_ROUTE/)
  assert.equal(calls[0].path,"/undo-preview")
  const app = await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  assert.doesNotMatch(app,/remove: true|adopt:|receiptUndo|\/undo["']/)
  assert.match(app,/renderPreview\(await call\("POST", "\/user-templates"/)
  assert.match(app,/renderPreview\(await call\("DELETE", "\/user-templates"/)
  assert.match(app,/replace: \[\.\.\.chosen\.values\(\)\]/)
  assert.match(app,/preview\.expiresAt/)
  assert.match(app,/confirmDiscardReceipts:true/)
  assert.match(app,/beforeExists !== false/)
  assert.match(app,/不是完整内容差异/)
  assert.match(app,/revision: snapshot\.revision, id, description, copyTemplateId/)
})
test("panel has local bridge, protected structural editor and no approval ritual", async () => {
  const html = await readFile(new URL("../openchamber/panel/index.html",import.meta.url),"utf8")
  const app = await readFile(new URL("../openchamber/panel/app.js",import.meta.url),"utf8")
  assert.match(html, /src="\.\/app\.js"/)
  assert.doesNotMatch(html, /https?:| checked|version-omo|七项|confirmations/)
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|postMessage|localStorage|console\.log/)
  assert.match(app, /vendor\/host\.js/)
  assert.match(app, /\/reveal/)
  assert.match(app, /confirmEnable: true/)
  assert.match(app, /snapshot\.revision, operations: safeOperations/)
  assert.match(app, /已有|秘密|受保护/)
})
