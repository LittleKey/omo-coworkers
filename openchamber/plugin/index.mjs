import claudeAdvisor from "../../plugins/claude-advisor/index.js"
import { setupWriterRole } from "./writer-role.mjs"

// Process environment is operator authority, never session/plugin options.
// Both extension features require independent, explicit operator opt-in.
export default {
  id: "omo-coworkers",
  async setup(ctx) {
    if (process.env.OMO_COWORKERS_ENABLE_WRITER_ROLE === "1") await setupWriterRole(ctx)
    if (process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD === "1") await claudeAdvisor.setup(ctx)
  },
}
