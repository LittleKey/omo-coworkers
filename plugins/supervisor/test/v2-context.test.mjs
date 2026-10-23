import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import supervisor from "../index.js"

async function setup(t, parentID, events = []) {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-v2-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let handler
  const unload = await supervisor.setup({ options: { mode: "inject", logPath: join(dir, "log.jsonl") },
    event: { subscribe: async function* () { for (const event of events) yield event } },
    session: { get: async ({ sessionID }) => ({ id: sessionID, parentID, title: "Review" }),
      hook: async (name, cb) => { assert.equal(name, "context"); handler = cb } },
  })
  t.after(unload)
  return { handler, logs: () => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map(JSON.parse) }
}
const request = () => ({ sessionID: "ses_native", messages: [
  { id: "u1", role: "user", content: [{ type: "text", text: "please run git push -f origin main now" }] },
  { id: "a1", role: "assistant", content: [] },
] })

// Rule A (high-stakes command nudge) was retired 2026-10-23; this flow now
// drives rule B1 (completion-sync) through the v2 event stream: a todowrite
// seeds the todo state, an assistant text part delivers a task terminal
// signal, then two assistant decisions pass → the next request injects.
const b1Events = (sid) => [
  { type: "session.created", properties: { info: { id: sid, title: "New session" } } },
  { type: "message.updated", properties: { info: { id: "u1", role: "user", sessionID: sid } } },
  { type: "message.part.updated", properties: { part: { type: "tool", callID: "c1", tool: "todowrite", messageID: "u1", sessionID: sid, state: { status: "completed", input: { todos: [{ id: "1", status: "completed" }, { id: "2", status: "in_progress" }] } } } } },
  { type: "message.part.updated", properties: { part: { type: "text", messageID: "m1", sessionID: sid, text: '<task id="7" state="completed">subagent delivery</task>' } } },
  { type: "message.updated", properties: { info: { id: "d1x", role: "assistant", sessionID: sid } } },
  { type: "message.updated", properties: { info: { id: "d1y", role: "assistant", sessionID: sid } } },
]

test("native v2 request appends valid content and does not recount a repeated snapshot", async t => {
  const { handler, logs } = await setup(t, undefined, b1Events("ses_native"))
  await new Promise(r => setImmediate(r)) // let the detached event drain finish
  const event = request(), original = structuredClone(event.messages)
  await handler(event)
  assert.deepEqual(event.messages.slice(0, 2), original)
  assert.equal(event.messages.length, 3)
  assert.equal(event.messages[2].role, "user")
  assert.match(event.messages[2].content[0].text, /\[supervisor-nudge\]/)
  await handler(request())
  assert.equal(logs().filter(x => x.kind === "user_turn").length, 1)
  assert.equal(logs().filter(x => x.kind === "injected").length, 1)
})

test("native subagent agent=claude suppresses an unnecessary adviser nudge", async t => {
  const { handler, logs } = await setup(t)
  const event = request()
  event.messages[1].content.push({ type: "tool-call", toolName: "subagent", toolCallId: "call_1", input: { agent: "claude" } })
  await handler(event)
  await handler(event)
  assert.equal(event.messages.length, 2)
  assert.equal(logs().filter(x => x.kind === "adviser_call" && x.name === "claude").length, 1)
})

test("native child sessions remain excluded", async t => {
  const { handler } = await setup(t, "ses_parent")
  const event = request()
  await handler(event)
  assert.equal(event.messages.length, 2)
})
