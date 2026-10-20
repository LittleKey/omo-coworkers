// Claude advisor dispatch guard (v2 entry).
//
// OpenCode v2 plugin contract: default export object with `id` and
// `setup(ctx)`. Registrations here are disposable and scoped to the plugin
// lifetime. The guard rules live in guard.mjs and are shared verbatim with
// the v1 entry (index.mjs), so both host generations enforce identical
// checkpoints (delegation to claude via task/subagent, and acp_run targeting
// claude: printable-ASCII, byte caps, exact acp_run parameter allowlist).
//
// Mapping: v1 "tool.execute.before" -> ctx.tool.hook("execute.before", ...)
// where the event carries `tool` and the MUTABLE `input` (the tool args).
// Throwing inside the callback blocks execution — the shared predicate
// throws on any violation, so rejection semantics match v1 exactly.
//
// Node builtins only; no third-party deps.

import { assertClaudeDispatchAllowed } from "./guard.mjs"

const claudeAdvisor = {
  id: "claude-advisor",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      assertClaudeDispatchAllowed(event?.tool, event?.input)
    })
    // No cleanup needed: the guard is stateless.
  },
}

export default claudeAdvisor
