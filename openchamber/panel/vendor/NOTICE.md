This directory vendors the unmodified browser `host.js` import closure from
`@openchamber/sdk` 2.8.0 (MIT; license alongside).
Source: https://github.com/openchamber/openchamber/tree/main/packages/sdk

Only the official `connectHost().serviceRequest()` bridge is used by this panel.
No package install, CDN, remote script or runtime dependency is required.
Other SDK methods remain upstream code; the panel does not call them.
