# mcp

Apply these rules to `bundles/features/mcp/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to connecting a Project's MCP servers and offering their
tools and skills to that Project's prompts, with the OAuth sign-in of remote
servers and the sidebar pane that manages them. Never add a server that
belongs to no Project or to the host, a tool or skill of Doric's own, or a
way to run a skill: running a prompt and its skills belongs to the agent
that reads the skill source.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to
  it.
- Keep `desktopScope` of `mcp/v1` in [`manifest.json`](manifest.json)
  listing `projectId`: every window call carries its Project in its scope.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "mcp"`.
- Read the Project of every `mcp/v1` and `default.skill-sources/v1` call only through `projectOf`, and every
  server only through `serverOf`, in `src/host/index.ts`, so that a call
  without a Project is refused and another Project's server answers
  `mcp_server_missing`.
- Never start a `stdio` server on the host: start it only in
  `src/host/open.ts`, through `runtime.lease/v1.withLease` and the sandbox's
  `start`, and pass it only its own resolved entries.
- Never put a secret in an `mcp.server/v1` document: store a token or a
  client secret only as an `MCP_TOKEN` credential through the vault of
  `src/host/credentials.ts`, and write OAuth state only through that vault
  with the `serverUrl` its `load` answered.
- Resolve only the connecting server's own entries, and keep refusing an
  entry that names an `MCP_TOKEN` credential on `create`, `update` and
  connect.
- Pass every message, status and log field that can carry a server's output
  or error through `redact` with the connection's secrets.
- Change a server's document only inside `store.lock(id)`, and check a
  Project's names together with the write they allow inside
  `store.lockProject(projectId)`; take a server lock inside a Project lock,
  never the reverse, and call `manager.stop` and `signIns.cancel` only after
  the lock is released.
- Register and unregister server tools only in `src/host/manager.ts`: a tool
  is registered only while its server is `connected`, under the server's
  Project, with a name from `toolName`.
- Let only `createSignIns` in `src/host/oauth.ts` register an OAuth client or
  build an authorization URL; keep the background provider throwing
  `SignInRequired` for both.
- Keep `src/contracts/` free of `@modelcontextprotocol/sdk`: the window loads
  it.
- Add a member to `mcp/v1` in `Mcp` and in `mcpMethods` of
  `src/contracts/index.ts` together, with `expose: 'desktop'` unless only the
  host may call it, implement it in `src/host/index.ts`, and add each new
  error code to `mcpErrorCodes`.
- Add a per-server setting as an optional field of `McpTransport` and of
  `mcpTransportSchema`; the `mcp.server/v1` document in `src/host/store.ts`
  extends that schema, so raise the minor of both the `mcp/v1` and the
  `mcp.server/v1` entries of `provides`. Then carry it through
  `ServerDraft`, `emptyDraft`, `draftOf`, `inputOf` and `errorsOf` in
  `src/client/draft.ts` and a field of `src/client/server-dialog.tsx`; put a
  setting most servers leave alone in the dialog's Advanced section.
- Add a transport behavior in `src/host/open.ts` (and `src/host/stdio.ts` for
  the process transport), a connection or status behavior in
  `src/host/manager.ts`, and a new status in `mcpStatuses`, in `statusOf`
  of `src/client/elements.tsx`, in `names` of
  `stories/support/fixtures.ts` and in the README's Statuses.
- Turn a new MCP content block into text only in `formatResult` of
  `src/host/tools.ts`, and update
  [attachments](../../../docs/features/attachments.md) when an image's text
  changes; change the Skills extension only in `src/host/skills.ts`.
- Call `mcp/v1`, `secrets/v1`, `doric.browser/v1` and `doric.connection/v1`
  from the client part
  only in `src/client/api.ts`, and bind every `mcp/v1` call to
  `services.use(McpV1, { projectId })` of the Project it is about.
- Keep the pane's state and its sign-ins in the activation's store
  (`src/client/store.ts`) and `src/client/sign-in.ts`; an element keeps only
  which of its dialogs is open.
- Reach `workspace.selection/v1` and `layout.stack/v2` only through the
  structural copies in `src/client/peers.ts`, and never import
  `layout/contracts` or `workspace/contracts`; when the owner changes a
  member the part uses, change the copy to match.
- When `src/client/` uses a utility class that
  [`src/client/styles.css`](src/client/styles.css) does not list, add it to
  that file's `@source inline(…)` list and to `TOKENS` of
  [`tests/styles-cascade.test.ts`](tests/styles-cascade.test.ts) in the same
  order; never let the sheet scan source files, and keep the built sheet
  under 8192 bytes.
- Test host behavior in `tests/*.test.ts` through the activated host part of
  [`tests/support/world.ts`](tests/support/world.ts), against the real SDK
  servers of `tests/support/mcp-server.ts`, the authorization server of
  `tests/support/oauth-server.ts` and the sandbox of
  `tests/support/sandbox.ts`; extend those fakes instead of replacing a host
  module. Put each test in the file of its area: `tools.test.ts`,
  `oauth.test.ts`, `skills.test.ts`, `http.test.ts`, `stdio.test.ts` and
  `stdio-transport.test.ts`, `configuration.test.ts`, `credentials.test.ts`.
- Test the client part in `tests/client/sidebar.test.ts` only through
  `activate` and the elements it defines, and the command line and draft
  checks in `tests/client/draft.test.ts`.
- Update the feature doc [mcp](../../../docs/features/mcp.md) with every
  change of what a server does, when it connects, or how a sign-in works,
  and [skills](../../../docs/features/skills.md) or
  [credentials](../../../docs/features/credentials.md) when the change touches
  the skill source or the `MCP_TOKEN` credentials.

## Verify

- `npx nx run bundle-mcp:typecheck`: run it after any change under `src/`,
  `stories/` or `.storybook/`.
- `npx nx run bundle-mcp:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the
  bundle first, because `tests/styles-cascade.test.ts` reads the built
  `dist/client/styles.css`.
- `npx nx run bundle-mcp:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file, `src/contracts/` or
  `src/client/styles.css`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
