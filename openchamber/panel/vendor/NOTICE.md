This directory vendors the unmodified browser `host.js` import closure and
`ui/theme.js` (stored as `theme.js`) from
`@openchamber/sdk` 2.8.0 (MIT; license alongside).
Source: https://github.com/openchamber/openchamber/tree/main/packages/sdk

The panel uses the official `connectHost().serviceRequest()` bridge and
`onReady()` with `applyHostReady()` for host theme tokens.
No package install, CDN, remote script or runtime dependency is required.
Other SDK methods remain upstream code; the panel does not call them.
