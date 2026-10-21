// Claude advisor dispatch guard (v1 entry).
//
// Stateless OpenCode plugin registering a single tool.execute.before hook in
// front of the external claude advisor. The guard rules live in guard.mjs and
// are shared verbatim with the v2 entry (index.js), so both host generations
// enforce identical checkpoints:
//   1. delegation to claude (v1 tool "task", v2.1.0+ tool "subagent") with
//      args.subagent_type === "claude": args.prompt and
//      args.description must be non-empty printable ASCII (tab/LF/CR allowed),
//      prompt <= 524288 bytes (512 KiB), description <= 160 bytes.
//   2. acp_run with args.agent === "claude": args.prompt gets the same ASCII
//      and 524288-byte rules, and the call may carry exactly the keys
//      {agent, prompt}; anything else (cwd, timeout_ms, ...) is rejected.
//
// Node builtins only; no absolute filesystem paths; no third-party deps.

import { assertClaudeDispatchAllowed } from "./guard.mjs"

export const ClaudeAdvisorGuard = async () => ({
  "tool.execute.before": async (input, output) => {
    const tool = input?.tool
    const args = output?.args ?? input?.args
    assertClaudeDispatchAllowed(tool, args)
  },
})

export default ClaudeAdvisorGuard
