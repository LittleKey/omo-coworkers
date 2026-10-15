// E2E mock provider (pattern reused from /tmp/opencode/probe2/mock/server.mjs).
// OpenAI-compatible: captures every request body to CAPTURE (jsonl), replies
// with canned SSE. MODE=toolcall: the first MAIN (non-title) request gets a
// glob tool_call so opencode loops back with a second main request within the
// same user turn; later requests get plain text.
import http from "node:http"
import fs from "node:fs"

const PORT = Number(process.env.MOCK_PORT ?? 4399)
const CAPTURE = process.env.MOCK_CAPTURE
const TOOLCALL_FIRST = process.env.MOCK_TOOLCALL_FIRST === "1"

let mainRequests = 0

const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    if (body.length > 0) {
      fs.appendFileSync(CAPTURE, JSON.stringify({ t: Date.now(), method: req.method, url: req.url, body }) + "\n")
    }
    if (req.method !== "POST") {
      res.writeHead(404)
      res.end()
      return
    }
    const parsed = JSON.parse(body)
    const isTitle = (parsed.messages ?? []).some(
      (m) => m.role === "system" && String(Array.isArray(m.content) ? "" : m.content).includes("title generator"),
    )
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    if (TOOLCALL_FIRST && !isTitle && mainRequests++ === 0) {
      res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_e2e_1", type: "function", function: { name: "glob", arguments: "" } }] }, null))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ pattern: "*.json", path: "/tmp/opencode" }) } }] }, null))
      res.write(chunk({}, "tool_calls"))
    } else {
      res.write(chunk({ role: "assistant", content: "" }, null))
      res.write(chunk({ content: "MOCK-REPLY-OK" }, null))
      res.write(chunk({}, "stop"))
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
})
server.listen(PORT, "127.0.0.1", () => console.log(`mock on ${PORT}`))
