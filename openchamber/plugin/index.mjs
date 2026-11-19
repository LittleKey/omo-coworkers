import claudeAdvisor from "../../plugins/claude-advisor/index.js"

// Process environment is operator authority, never session/plugin options.
// The legacy entries remain unconditional for separately managed dotfiles.
export default {
  id: "omo-coworkers",
  async setup(ctx) {
    if (process.env.OMO_COWORKERS_ENABLE_CLAUDE_GUARD !== "1") return
    await claudeAdvisor.setup(ctx)
  },
}
