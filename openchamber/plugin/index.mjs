import claudeAdvisor from "../../plugins/claude-advisor/index.js"
import { setupWriterRole } from "./writer-role.mjs"
import { readBehaviorSettings } from "./behavior-settings.mjs"
import { setupCatalogPublisher } from "./catalog-publisher.mjs"

// Settings are operator authority, never session/plugin options.
export default {
  id: "omo-coworkers",
  async setup(ctx) {
    const settings = readBehaviorSettings()
    if (settings.writerTransformEnabled) await setupWriterRole(ctx)
    if (settings.claudeGuardEnabled) await claudeAdvisor.setup(ctx)
    return setupCatalogPublisher(ctx)
  },
}
