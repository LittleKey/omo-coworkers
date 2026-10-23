// supervisor-nudge — opencode v2 plugin entry, L0 bounded implementation.
//
// Spec: docs/supervisor-nudge-design-v2.md (authoritative). Phase mapping
// (resolved via the shared config module, identical to the v1 entry):
//   mode "observe" (default) = phase one: log-only, zero injection/wake/LLM.
//   mode "inject"            = phase two: minimal L0 pre-request injection.
//
// Registers exactly two things (registrations are disposable and scoped to
// the plugin lifetime):
//   ctx.event.subscribe()        — single observation source (observe only,
//                                  no mutation)
//   ctx.session.hook("context")  — single injection point, fired immediately
//                                  before each agent model request
//
// All handler logic lives in ./lib/runtime.mjs and is shared verbatim with
// the v1 entry (index.mjs), so both host generations behave identically.
// Options are read from ctx.options (v2 config form:
// {"package": "...", "options": {...}}). Node builtins only; no timers, no
// LLM calls, never throws into the host.

import { createSupervisorCore } from "./lib/runtime.mjs"
import { createV2ContextHandler } from "./lib/v2-context.mjs"
import { registerMemoryTool } from "./lib/memory/tool.mjs"

const supervisor = {
  id: "supervisor",
  async setup(ctx) {
    const core = createSupervisorCore(ctx?.options)

    // Observation side: consume the host event stream. The consumer runs
    // detached so setup() returns immediately; per-event handling never
    // throws (core.v2.onEvent catches internally). `disposed` stops the
    // loop when the plugin is unloaded.
    let disposed = false
    const consumeEvents = async () => {
      try {
        const events = await ctx.event.subscribe()
        for await (const event of events) {
          if (disposed) break
          await core.v2.onEvent(event)
        }
      } catch (err) {
        try {
          core.log.write({
            kind: "internal_error",
            where: "event.subscribe",
            error: String(err?.message ?? err),
          })
        } catch {
          /* never propagate */
        }
      }
    }
    consumeEvents()

    // Injection side: same handler semantics as v1
    // "experimental.chat.messages.transform" (mode "observe" logs only;
    // mode "inject" appends at most one nudge message per request).
    const nativeContext = createV2ContextHandler(core, async (sessionID) => {
      return await ctx.session.get({ sessionID })
    })
    await ctx.session.hook("context", async (event) => {
      // Retain the v1-shaped path for compatibility callers.
      if (event?.messages?.some(message => message.info)) return core.v2.onContext(event)
      return nativeContext(event)
    })

    // Optional memory tool face (m1 P2): registered only when explicitly
    // enabled (options.memory.enable === true); default OFF means no
    // registration and zero behavior difference. Any failure here is logged
    // and swallowed — the L0/inject paths above must never be affected (D1
    // fault isolation).
    try {
      await registerMemoryTool(ctx, { log: (entry) => core.log.write(entry) })
    } catch (err) {
      try {
        core.log.write({
          kind: "internal_error",
          where: "memory.register",
          error: String(err?.message ?? err),
        })
      } catch {
        /* never propagate */
      }
    }

    // No documented API exists to cancel the subscription stream, so the
    // unload function only stops event processing.
    return () => {
      disposed = true
    }
  },
}

export default supervisor
