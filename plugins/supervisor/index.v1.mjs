// supervisor-nudge — opencode v1 plugin entry, L0 bounded implementation.
//
// Spec: docs/supervisor-nudge-design-v2.md (authoritative). Phase mapping:
//   mode "observe" (default) = phase one: log-only, zero injection/wake/LLM.
//   mode "inject"            = phase two: minimal L0 pre-request injection.
//
// Registers exactly two hooks:
//   event                                  — single observation source
//   experimental.chat.messages.transform   — single injection point
//
// All handler logic lives in ./lib/runtime.mjs and is shared verbatim with
// the v2 entry (index.js), so both host generations behave identically.
//
// The default export is the plugin factory and returns the hooks object
// DIRECTLY (wrapping it in { hooks: {} } is silently ignored by the host).
// Node builtins only; no timers, no LLM calls, never throws into the host.

import { createSupervisorCore } from "./lib/runtime.mjs"

export const SupervisorNudge = async (_pluginInput, options) => {
  const core = createSupervisorCore(options)
  return {
    event: core.v1.event,
    "experimental.chat.messages.transform": core.v1.transform,
  }
}

export default SupervisorNudge
