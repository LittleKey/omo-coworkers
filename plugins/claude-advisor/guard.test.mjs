// Tests for the claude-advisor dispatch guard (plugins/claude-advisor/index.v1.mjs).
// Run: node --test plugins/claude-advisor/guard.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import { ClaudeAdvisorGuard } from "./index.v1.mjs"
import claudeAdvisorV2 from "./index.js"

const hooks = await ClaudeAdvisorGuard()
assert.deepEqual(Object.keys(hooks), ["tool.execute.before"], "plugin must register exactly one hook")
const before = hooks["tool.execute.before"]

const run = (tool, args) => before({ tool, sessionID: "guard-test" }, { args })

const rejectedMessages = []
async function expectReject(tool, args, marker) {
  await assert.rejects(
    () => run(tool, args),
    (err) => {
      assert.ok(err instanceof Error, "violation must throw an Error")
      assert.match(err.message, /^Claude dispatch rejected: /, "error must name the failed rule in English")
      if (marker !== undefined) assert.ok(!err.message.includes(marker), "error message must not echo rejected content")
      assert.match(err.message, /^[\x09\x0A\x0D\x20-\x7E]*$/, "error message itself must stay ASCII")
      rejectedMessages.push(err.message)
      return true
    },
    `expected ${tool} call to be rejected`
  )
}

test("checkpoint 1: plain ASCII task for claude is accepted", async () => {
  await run("task", { subagent_type: "claude", prompt: "Review the cache policy in src/cache.ts.", description: "Cache review" })
})

test("checkpoint 1: exactly-at-cap prompt (8192 B) and description (160 B) are accepted", async () => {
  await run("task", { subagent_type: "claude", prompt: "a".repeat(8192), description: "d".repeat(160) })
})

test("checkpoint 1: CJK prompt is rejected", async () => {
  await expectReject("task", { subagent_type: "claude", prompt: "MARKER1 评估缓存方案", description: "ok" }, "MARKER1")
})

test("checkpoint 1: CJK description is rejected", async () => {
  await expectReject("task", { subagent_type: "claude", prompt: "ok", description: "MARKER4 架构评审" }, "MARKER4")
})

test("checkpoint 1: full-width punctuation is rejected", async () => {
  await expectReject("task", { subagent_type: "claude", prompt: "MARKER2 review（cache），decide。", description: "ok" }, "MARKER2")
})

test("checkpoint 1: curly quotes and arrows are rejected", async () => {
  await expectReject("task", { subagent_type: "claude", prompt: "MARKER3 use “quotes” and → go", description: "ok" }, "MARKER3")
})

test("checkpoint 1: empty, whitespace-only, and missing prompt are rejected", async () => {
  await expectReject("task", { subagent_type: "claude", prompt: "", description: "ok" })
  await expectReject("task", { subagent_type: "claude", prompt: " \t\n ", description: "ok" })
  await expectReject("task", { subagent_type: "claude", description: "ok" })
})

test("checkpoint 1: prompt over 8192 bytes is rejected", async () => {
  await expectReject("task", { subagent_type: "claude", prompt: "x".repeat(8192) + "MARKER5", description: "ok" }, "MARKER5")
})

test("checkpoint 1: description over 160 bytes is rejected", async () => {
  await expectReject("task", { subagent_type: "claude", prompt: "ok", description: "y".repeat(161) })
})

test("checkpoint 1 (v2 tool name): plain and at-cap subagent for claude are accepted", async () => {
  await run("subagent", { subagent_type: "claude", prompt: "Review the cache policy in src/cache.ts.", description: "Cache review" })
  await run("subagent", { subagent_type: "claude", prompt: "a".repeat(8192), description: "d".repeat(160) })
})

test("checkpoint 1 (v2 tool name): oversized subagent prompt is rejected", async () => {
  await expectReject("subagent", { subagent_type: "claude", prompt: "x".repeat(8192) + "MARKER7", description: "ok" }, "MARKER7")
})

test("checkpoint 1 (v2 tool name): non-ASCII subagent prompt is rejected", async () => {
  await expectReject("subagent", { subagent_type: "claude", prompt: "MARKER8 评估缓存方案", description: "ok" }, "MARKER8")
})

test("non-claude subagent passes through untouched", async () => {
  const args = { subagent_type: "general", prompt: "评估缓存方案", description: "架构评审" }
  await run("subagent", args)
  assert.deepEqual(args, { subagent_type: "general", prompt: "评估缓存方案", description: "架构评审" })
})

test("checkpoint 2: acp_run with exactly {agent, prompt} is accepted", async () => {
  await run("acp_run", { agent: "claude", prompt: "Reassess the cache capacity policy." })
})

test("checkpoint 2: extra parameters (cwd, timeout_ms) are rejected", async () => {
  await expectReject("acp_run", { agent: "claude", prompt: "ok", cwd: "/tmp" })
  await expectReject("acp_run", { agent: "claude", prompt: "ok", timeout_ms: 60000 })
})

test("checkpoint 2: non-ASCII and over-cap acp_run prompts are rejected", async () => {
  await expectReject("acp_run", { agent: "claude", prompt: "MARKER6 评估" }, "MARKER6")
  await expectReject("acp_run", { agent: "claude", prompt: "z".repeat(8193) })
})

test("non-claude task/acp_run and other tools pass through untouched", async () => {
  const taskArgs = { subagent_type: "general", prompt: "评估缓存方案", description: "架构评审" }
  await run("task", taskArgs)
  assert.deepEqual(taskArgs, { subagent_type: "general", prompt: "评估缓存方案", description: "架构评审" })

  const acpArgs = { agent: "gemini", prompt: "评估", cwd: "/tmp", timeout_ms: 1 }
  await run("acp_run", acpArgs)
  assert.deepEqual(acpArgs, { agent: "gemini", prompt: "评估", cwd: "/tmp", timeout_ms: 1 })

  await run("read", { filePath: "/tmp/任意" })
})

test("v2 hook enforces the native subagent agent selector", async () => {
  let handler
  await claudeAdvisorV2.setup({ tool: { hook: async (name, cb) => {
    assert.equal(name, "execute.before")
    handler = cb
  } } })
  await handler({ tool: "subagent", input: { agent: "claude", prompt: "Review cache.", description: "Cache review" } })
  await assert.rejects(() => handler({ tool: "subagent", input: { agent: "claude", prompt: "x".repeat(8193), description: "Review" } }), /limit is 8192/)
  await assert.rejects(() => handler({ tool: "subagent", input: { agent: "claude", prompt: "评估", description: "Review" } }), /printable ASCII/)
  await handler({ tool: "subagent", input: { agent: "oracle", prompt: "评估", description: "Review" } })
})

test("no rejected content is ever echoed in error messages", async () => {
  assert.ok(rejectedMessages.length >= 10, "expected rejections from the cases above to be collected")
  for (const msg of rejectedMessages) {
    assert.match(msg, /^Claude dispatch rejected: /)
    assert.doesNotMatch(msg, /[\u0080-\uFFFF]/, "error message must stay pure ASCII")
    for (const marker of ["MARKER1", "MARKER2", "MARKER3", "MARKER4", "MARKER5", "MARKER6", "MARKER7", "MARKER8"]) {
      assert.ok(!msg.includes(marker), `error message must not echo rejected content (${marker})`)
    }
  }
})
