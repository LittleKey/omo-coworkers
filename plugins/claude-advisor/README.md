# Claude advisor: current-project evidence

The source configuration in
[`dotfiles/opencode`](../../../dotfiles/opencode/claude-advisor.md)
uses `acpAgents.claude.permissionMode: "reject"` and deliberately has no fixed
`cwd`. OMO resolves the working directory as
`args.cwd ?? config.cwd ?? ctx.directory`. This guard accepts only `{agent, prompt}`
for Claude `acp_run`, so callers cannot override the directory: each consultation
inherits the current session's project, including when switching projects.
The root OMO template need not acquire an `acpAgents` block.

Claude can normally read files within that project, including hidden `.opencode`
evidence such as `.opencode/bcp/exports/`. This relies on existing Claude access,
not a new blanket read grant. Explicit deny rules, sensitive-file protections,
and symlinks pointing outside the project can still prevent access. Missing
evidence must be reported rather than bypassed.

`reject` rejects additional ACP permission requests; it is not the transport
wrapper's OpenCode permission policy and does not revoke operations Claude
already allows. In particular, a read-only consultation request is **not a
read-only sandbox**: existing shell or editing permissions remain effective.
Access outside the project requires separate authorization; none is configured
here.

Keep the configuration free of a fixed `cwd`, auto-approval, external-cache
directory allowlists, and invented `allowedTools`/`add-dir` arguments. The ACP
adapter does not honor ordinary Claude CLI extra arguments as an authorization
mechanism. Do not change actual Claude settings to make this source policy work.

## Focused source regression

From the OMO repository root:

```sh
node --test plugins/claude-advisor/guard.test.mjs
```

The configuration check defaults to the sibling checkout
`../dotfiles/opencode/oh-my-opencode-slim.json`. For another checkout layout:

```sh
CLAUDE_ADVISOR_CONFIG=/absolute/path/to/oh-my-opencode-slim.json \
  node --test plugins/claude-advisor/guard.test.mjs
```

A missing configuration fails explicitly, rather than skipping. These tests
check source configuration and the dispatch guard only; they neither launch
Claude nor verify live Claude permissions.
