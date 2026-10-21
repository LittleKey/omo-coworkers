// Shared dispatch-guard predicate for the claude advisor, used by BOTH host
// generations:
//   - v1 entry (index.mjs):  "tool.execute.before" hook map
//   - v2 entry (index.js):   ctx.tool.hook("execute.before", ...)
//
// Two fail-fast checkpoints in front of the external claude advisor:
//   1. delegation to claude — v1 tool "task", v2.1.0+ tool "subagent" — with
//      args.subagent_type (v1) or args.agent (v2) === "claude": args.prompt and
//      args.description must be non-empty printable ASCII (tab/LF/CR allowed),
//      prompt <= 524288 bytes (512 KiB), description <= 160 bytes.
//   2. acp_run with args.agent === "claude": args.prompt gets the same ASCII
//      and 524288-byte rules, and the call may carry exactly the keys
//      {agent, prompt}; anything else (cwd, timeout_ms, ...) is rejected.
//
// The predicate THROWS on violation (blocking execution in both generations)
// and returns normally on pass-through. Error messages stay ASCII and never
// echo the rejected content. Deliberately out of scope: file/board content
// checks, language detection, task<->acp_run consistency checks, persisted
// state, retries/transliteration. Node builtins only; no third-party deps.

const PRINTABLE_ASCII = /^[\x09\x0A\x0D\x20-\x7E]+$/
const PROMPT_MAX_BYTES = 524288
const DESCRIPTION_MAX_BYTES = 160

function reject(rule) {
  throw new Error(`Claude dispatch rejected: ${rule}`)
}

function checkAsciiField(field, label, maxBytes) {
  if (typeof field !== "string" || field.trim() === "") {
    reject(`${label} must be non-empty printable ASCII text.`)
  }
  if (!PRINTABLE_ASCII.test(field)) {
    reject(
      `${label} must contain printable ASCII text, tabs, or line breaks only. ` +
        `Put supporting material in project files and reference it using ASCII relative paths.`
    )
  }
  const bytes = Buffer.byteLength(field, "utf8")
  if (bytes > maxBytes) {
    reject(`${label} is ${bytes} bytes; the limit is ${maxBytes} bytes.`)
  }
}

// V2 renamed both the tool and its agent selector. Retain the legacy selector
// for callers using the compatibility shape.
const DELEGATION_TOOLS = new Set(["task", "subagent"])

export function assertClaudeDispatchAllowed(tool, args) {
  if (!args || typeof args !== "object") return

  const agent = tool === "subagent" ? (args.agent ?? args.subagent_type) : args.subagent_type
  if (DELEGATION_TOOLS.has(tool) && agent === "claude") {
    checkAsciiField(args.prompt, "task prompt", PROMPT_MAX_BYTES)
    checkAsciiField(args.description, "task description", DESCRIPTION_MAX_BYTES)
    return
  }

  if (tool === "acp_run" && args.agent === "claude") {
    for (const key of Object.keys(args)) {
      if (key !== "agent" && key !== "prompt") {
        reject(`acp_run for claude accepts only the "agent" and "prompt" parameters; "${key}" is not allowed.`)
      }
    }
    checkAsciiField(args.prompt, "acp_run prompt", PROMPT_MAX_BYTES)
  }
}
