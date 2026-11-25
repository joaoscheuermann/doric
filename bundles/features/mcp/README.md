# mcp

`mcp` connects a Project to MCP (Model Context Protocol) servers and gives
their tools and skills to that Project's prompts. A server belongs to the
Project it is created in: its tools are registered only under that Project,
and every method of its contract works on the Project of the call's scope
([src/host/index.ts](src/host/index.ts),
[src/host/manager.ts](src/host/manager.ts)).

The feature across bundles is described in
[docs/features/mcp.md](../../../docs/features/mcp.md); how a Project's sandbox
runs its processes is in
[docs/features/projects-and-threads.md](../../../docs/features/projects-and-threads.md).
The skill source is described in
[docs/features/skills.md](../../../docs/features/skills.md), the `MCP_TOKEN`
credentials in [docs/features/credentials.md](../../../docs/features/credentials.md),
the images of tool results in
[docs/features/attachments.md](../../../docs/features/attachments.md), and the
pane's place in the window in
[docs/features/ui-redesign.md](../../../docs/features/ui-redesign.md).
How bundles are built, loaded and composed is in
[`packages/bundle`](../../../packages/bundle/README.md).

## Manifest

[`manifest.json`](manifest.json):

- `manifestVersion` `1`, `id` `mcp`, `version` `1.3.0`, `engines.doric`
  `^1.0.0`.
- `description`: `MCP servers per Project: their tools for the Project's
prompts, with OAuth sign-in for remote servers.`
- `provides`: `mcp/v1@1.3.0`, `mcp.server/v1@1.2.0`,
  `default.skill-sources/v1@1.1.0`.
- `requires`: `tools/v1@^1.5.0`, `storage/v1@^1.1.0`, `secrets/v1@^1.3.0`,
  `hooks/v1@^1.1.0`, `log/v1@^1.0.0`, `runtime/v2@^2.1.0`,
  `runtime.hooks/v1@^1.3.0`, `runtime.lease/v1@^1.5.0`,
  `runtime.attachments/v1@^1.1.0`, `ui/v1@^1.0.0`,
  `workspace.selection/v1@^1.0.0`, `layout.stack/v2@^2.0.0`.
- `optional`: none.
- `desktopScope`: a desktop call of `mcp/v1` may carry `projectId`,
  `threadId` and `promptId` in its scope
  ([manifest](../../../docs/architecture/bundles/manifest.md)).

The package ([`package.json`](package.json)) exports `./contracts`
(`mcp/contracts`), `./contracts/gen/*` (the protobuf-es code `generate-proto` writes from `proto/`) and `./package.json`.

## Parts

| Part      | Entry                                            | What it does                                                                                                                                                     |
| --------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts | [src/contracts/index.ts](src/contracts/index.ts) | The `mcp/v1` types, schemas, constants and wire shapes, and `serverSlug`. Shared by the host and the window: it imports neither the MCP SDK nor any Node module. |
| host      | [src/host/index.ts](src/host/index.ts)           | Stores the servers, connects them, registers their tools, serves their skills, runs the OAuth sign-in, and provides `mcp/v1` and `default.skill-sources/v1`.     |
| client    | [src/client/index.ts](src/client/index.ts)       | Draws the sidebar's MCP pane, the dialogs that add, edit and remove a server, and its browser sign-in.                                                           |

The bundle has no desktop part.

Host modules:

- [src/host/index.ts](src/host/index.ts): wires the kernel only — builds
  `kernelMcpPorts`, the store, the vault and the manager, registers the
  runtime hooks (including the `onProjectReadyHook` handler) and provides the
  contracts from `createMcpOperations`.
- [src/host/ports.ts](src/host/ports.ts): `McpPorts` (`storage`, `secrets`,
  `tools`, `lease`, `log`), everything the host part uses from Doric, and
  `kernelMcpPorts`, which builds them from the kernel's services; `storage`
  and `secrets` forward exactly the caller's arguments.
- [src/host/operations.ts](src/host/operations.ts): `createMcpOperations`,
  the bodies of the `mcp/v1` and `default.skill-sources/v1` methods, with
  `projectOf` and `serverOf`.
- [src/host/store.ts](src/host/store.ts): the `mcp.server/v1` documents and
  the per-server and per-Project locks.
- [src/host/credentials.ts](src/host/credentials.ts): entry resolution,
  secret masking, the `MCP_TOKEN` kind and the OAuth vault.
- [src/host/manager.ts](src/host/manager.ts): `createManager({ ports, store, vault })`,
  the live connections, tool registration, status, the watchers and
  `sandboxReady`. Tool registration is asynchronous: a registration that lands
  while its connection closes is unregistered at once.
- [src/host/open.ts](src/host/open.ts): opening an `http` or `stdio`
  connection; `openStdio` starts the process through an `McpLease`, and a
  sandbox without `start` (or answering `unsupported_operation`) gives the
  "cannot keep a process running" message.
- [src/host/stdio.ts](src/host/stdio.ts): the MCP SDK transport over a sandbox
  process.
- [src/host/codec.ts](src/host/codec.ts): the routed messages of `mcp/v1` and
  `default.skill-sources/v1`. `serverInputOf` checks a routed input again with
  today's zod schema and answers `invalid_input`, "Invalid input for mcp/v1
  <Method>.", with the issues; `serverViewMessageOf` and
  `skillSourceEntryMessageOf` build the answers.
- [src/host/lease.ts](src/host/lease.ts): `routedMcpLease`, the `McpLease` over
  the router: it runs on the Project's lease (`runOnProjectLease`, scope
  `{projectId}` only) and starts a `stdio` process through
  `LeaseService.Start`, detached, resolving at `started`. An
  `unsupported_operation` refuses the start, so `open.ts` gives today's text.
- [src/host/main.ts](src/host/main.ts): the bundle's process (`runBundle`),
  serving `McpService`, `SkillSourcesService`, `ToolHandlerService` and
  `HookHandlerService`. The kernel entry (`index.ts`) stays until S62.
- [src/host/service.ts](src/host/service.ts): `createMcpHost`, the process's
  services over `createMcpOperations` and the routed ports. Every method
  answers `unavailable` "mcp is not active." before `activate` resolves, when
  it rejects, and after `deactivate`. `activate`, in order: `routedMcpPorts`;
  defines `mcp.server/v1` and waits for storage to settle; registers the
  `MCP_TOKEN` credential kind; registers the prompt-started, project-closing
  and project-ready hooks in one hook table; starts `watchProjectDeletions`;
  opens the services. `deactivate` closes the services, stops the deletion
  watch and stops the operations; it never rejects (a failure is logged at
  `warn`). `Watch` ends on the caller's signal; the server connections stay
  open.
- [src/host/routed.ts](src/host/routed.ts): the routed ports the process
  uses: `detached`, `routedSecrets`,
  `routedTools`, `routedAttach` (the bytes in chunks of at most 1 MiB),
  `routedMcpPorts` and `watchProjectDeletions`, which opens `runtime/v2.Watch`
  again 5 s after the stream ends, cleanly or with an error (logged at `warn`
  only for an error), and opens nothing after `dispose()`. Only Create's and
  Update's credential check and a tool call's image attach run in the caller's
  call; every other routed call is detached from it.
- [src/host/stream.ts](src/host/stream.ts): `streamOf`, `mcp`'s own copy of
  `chat`'s.
- [src/host/tools.ts](src/host/tools.ts): tool names, result text and
  `executeMcpTool`, the one tool call shared by `toDoricTool` (the kernel's
  tool definition) and `mcpToolDefinition` (for the bundle's future process).
- [src/host/skills.ts](src/host/skills.ts): the Skills extension and the skill
  source entries.
- [src/host/oauth.ts](src/host/oauth.ts): the OAuth provider and the browser
  sign-ins.

Client modules: [src/client/api.ts](src/client/api.ts) (every host call, over
the generated `McpService` and `SecretsService` from slice S65c),
[src/client/codec.ts](src/client/codec.ts) (today's server input and view
against the generated messages, a view checked against
`mcpServerViewSchema`), [src/client/store.ts](src/client/store.ts) (the pane's
state),
[src/client/elements.tsx](src/client/elements.tsx) (the pane),
[src/client/server-dialog.tsx](src/client/server-dialog.tsx) and
[src/client/catalog-table.tsx](src/client/catalog-table.tsx) (the dialog),
[src/client/draft.ts](src/client/draft.ts) (the dialog's draft and its
checks), [src/client/sign-in.ts](src/client/sign-in.ts) (the browser
sign-in), [src/client/peers.ts](src/client/peers.ts) (structural copies of
`workspace.selection/v1` and `layout.stack/v2`).

## Contracts provided

### `mcp/v1` 1.2.0

Declared in [src/contracts/index.ts](src/contracts/index.ts) as
`McpV1 = ref<Mcp>('mcp/v1')`, with its wire shapes in `mcpMethods`, and
provided by the host part
([src/host/index.ts](src/host/index.ts)). Every method reads
`call.scope.projectId`; a call without it, or with an empty one, is refused
with `invalid_input` and the message `mcp/v1 needs a Project scope.`
(`mcpScopeMessage`). Every method except `readSkill` is reachable from a
desktop window (`expose: 'desktop'`); `readSkill` is host only. A member
marked (1.1.0) or (1.2.0) exists from that minor on, so a bundle that uses it
requires at least that minor.

#### Types

```ts
type McpEntry =
  | { name: string; value: string } // a literal value
  | { name: string; credentialId: string }; // a stored credential's secret

interface McpClientInfo {
  name?: string;
  version?: string;
} // (1.2.0)

type McpTransport =
  | {
      kind: 'http';
      url: string; // http:// or https://
      headers: McpEntry[]; // names are RFC 7230 tokens
      clientName?: string; // (1.2.0) OAuth client_name; 1–128 chars, trimmed
      scopes?: string[]; // (1.2.0) OAuth scopes; at least one when present
      clientInfo?: McpClientInfo; // (1.2.0)
    }
  | {
      kind: 'stdio';
      command: string; // non-empty
      args: string[];
      cwd?: string; // non-empty when present
      env: McpEntry[]; // names match ^[A-Za-z_][A-Za-z0-9_]*$
      clientInfo?: McpClientInfo; // (1.2.0)
    };

interface McpServerInput {
  name: string;
  enabled: boolean;
  transport: McpTransport;
}

type McpStatus =
  | 'disabled'
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'needs-sign-in'
  | 'waiting-for-sandbox'
  | 'error';

interface McpToolView {
  name: string;
  title?: string;
  description?: string;
}
interface McpSkillView {
  uri: string;
  name: string;
  description: string;
}

interface McpServerView extends McpServerInput {
  id: string;
  projectId: string;
  status: { state: McpStatus; message?: string };
  signedIn: boolean; // OAuth tokens stored; always false for stdio
  tools: McpToolView[]; // empty unless connected
  skills: McpSkillView[]; // empty unless connected
}

interface McpSkillRef {
  id: string;
  uri: string;
}
interface McpSkillText {
  text: string;
}
```

Every object schema is strict: an unknown field is refused with
`invalid_input`. A server name is trimmed, 1 to 64 characters
(`MCP_NAME_MAX`), and holds at least one ASCII letter, digit or `-`. A
client info `name` is 1 to 128 characters and a `version` 1 to 64
(`MCP_CLIENT_VERSION_MAX`), both trimmed. An OAuth scope is printable ASCII
other than space, `"` and `\`.

Exported constants and helpers: `MCP_NAME_MAX` (64),
`MCP_DEFAULT_CLIENT_NAME` (`Doric`), `MCP_CLIENT_NAME_MAX` (128),
`MCP_DEFAULT_CLIENT_INFO` (`{ name: 'doric', version: '1.0.0' }`),
`MCP_CLIENT_VERSION_MAX` (64), `mcpErrorCodes`, `mcpStatuses`,
`mcpScopeMessage`, `mcpClientInfoOf(transport)` (the client info with each
absent field taken from `MCP_DEFAULT_CLIENT_INFO`), `serverSlug(name)`, and
the zod schemas `mcpTransportSchema`, `mcpServerNameSchema`,
`mcpServerInputSchema`, `mcpServerUpdateSchema`, `mcpServerRefSchema`,
`mcpSkillRefSchema`, `mcpSkillTextSchema`, `mcpToolViewSchema`,
`mcpSkillViewSchema` and `mcpServerViewSchema`.

`serverSlug(name)` lowercases the name, turns each run of characters outside
`[a-z0-9-]` (`_` included) into one `_`, drops leading `_`, cuts it to 20
characters and drops trailing `_` (`GitHub Copilot` → `github_copilot`). A
slug never holds `__`.

#### Statuses

A server's `status.state`, set by the host part
([src/contracts/index.ts](src/contracts/index.ts),
[src/host/manager.ts](src/host/manager.ts)):

- `disabled`: `enabled` is false; nothing runs and no tool is registered.
- `idle`: enabled, and nothing has connected it.
- `connecting`: a connection attempt or a tool listing is in progress.
- `connected`: its tools are registered for the Project.
- `needs-sign-in`: the server asks for OAuth and no stored token works.
- `waiting-for-sandbox`: a `stdio` server whose Project holds no sandbox
  lease.
- `error`: the last attempt failed or the connection closed; `message` says
  why, with every secret of the server's entries shown as `[REDACTED]`.

#### Methods

| Method                         | Input                                      | Output            | Errors besides `invalid_input`                                                                               |
| ------------------------------ | ------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `list`                         | none                                       | `McpServerView[]` | —                                                                                                            |
| `create`                       | `McpServerInput`                           | `McpServerView`   | `mcp_server_name_taken`                                                                                      |
| `update`                       | `McpServerInput & { id }`                  | `McpServerView`   | `mcp_server_missing`, `mcp_server_name_taken`                                                                |
| `remove`                       | `{ id }`                                   | `void`            | `mcp_server_missing`                                                                                         |
| `watch`                        | `[listener]` (stream of `McpServerView[]`) | `Disposable`      | —                                                                                                            |
| `signIn`                       | `{ id }`                                   | `{ url }`         | `mcp_server_missing`, `mcp_signin_unsupported`, `mcp_signin_aborted`, `mcp_signin_failed`                    |
| `finishSignIn`                 | `{ id }`                                   | `McpServerView`   | `mcp_server_missing`, `mcp_signin_not_started`, `mcp_signin_busy`, `mcp_signin_aborted`, `mcp_signin_failed` |
| `readSkill` (1.1.0, host only) | `McpSkillRef`                              | `McpSkillText`    | `mcp_server_missing`, `mcp_skill_unavailable`                                                                |

Each method's behavior ([src/host/index.ts](src/host/index.ts),
[src/host/manager.ts](src/host/manager.ts),
[src/host/oauth.ts](src/host/oauth.ts)):

- `list` answers the Project's servers in creation order with their live
  state; it never starts a connection.
- `create` refuses an entry that names an `MCP_TOKEN` credential, and a
  name whose slug another server of the Project has; it stores the server
  with a new UUID as its `id` and answers its view. An enabled server
  connects at once when its Project is watched, else at the next `watch` or
  prompt start.
- `update` applies the same checks, replaces the name, `enabled` and
  transport, and answers the stored view. When the transport kind or the
  `http` URL changes, it deletes the server's `MCP_TOKEN` credentials, drops
  its OAuth state and cancels its waiting sign-in; any other change keeps the
  tokens. It then stops a disabled server, or restarts an enabled one that
  was live or whose Project is watched.
- `remove` deletes the server's `MCP_TOKEN` credentials and its document,
  stops it (its tools are unregistered), and cancels its waiting sign-in.
- `watch` delivers the Project's servers (as `list`) on subscribe, then after
  every change of a server or its state, in order. It connects every enabled
  server of the Project that is neither connected nor connecting. Disposing
  the last watch keeps the connections. A listener that throws is logged; a
  remote listener's failed delivery is ignored.
- `signIn` prepares a browser OAuth sign-in of an `http` server and answers
  the authorization URL to open ([OAuth](#oauth)).
- `finishSignIn` waits for the browser's redirect of that sign-in, stores the
  tokens, reconnects the server and answers its view.
- `readSkill` reads one skill a connected server lists now, with
  `resources/read`, once per call ([Skills](#skills)).

A server of another Project reads as missing: every method that names a
server answers `mcp_server_missing` for it
([src/host/index.ts](src/host/index.ts)).

#### Error codes

`mcpErrorCodes` lists the codes `mcp/v1` raises besides `invalid_input`
([src/contracts/index.ts](src/contracts/index.ts)):

- `mcp_server_missing`: the Project holds no server with that id;
  `The Project holds no MCP server <id>.`
  ([src/host/index.ts](src/host/index.ts)).
- `mcp_server_name_taken`: another server of the Project has a name with the
  same slug; `Another MCP server of the Project is named like <name>.`
  ([src/host/index.ts](src/host/index.ts)).
- `mcp_signin_unsupported`: `signIn` of a `stdio` server;
  `A stdio MCP server has no sign-in.`
  ([src/host/oauth.ts](src/host/oauth.ts)).
- `mcp_signin_not_started`: `finishSignIn` with no sign-in of that server
  waiting, or one started for another URL;
  `No sign-in of this MCP server is waiting; start one first.`
  ([src/host/oauth.ts](src/host/oauth.ts)).
- `mcp_signin_busy`: another `finishSignIn` already waits on that sign-in;
  `The sign-in of this MCP server is already being finished.`
  ([src/host/oauth.ts](src/host/oauth.ts)).
- `mcp_signin_aborted`: the caller cancelled, a newer `signIn` of the same
  server replaced it, the server changed transport kind or URL or was
  removed, the sign-in timed out, or the bundle deactivated;
  `The MCP sign-in was cancelled.`
  ([src/host/oauth.ts](src/host/oauth.ts)).
- `mcp_signin_failed`: `The MCP sign-in failed: <reason>.`, or
  `The MCP sign-in failed: <reason> (<cause>).` when an error caused it,
  where `<reason>` is one of `the local callback could not start`,
  `the authorization could not be prepared` (discovery or registration),
  `the browser did not answer`,
  `the authorization server answered <error>[: <description>]`,
  `the redirect names another authorization server`,
  `the redirect carries no authorization code` and
  `the token exchange failed` ([src/host/oauth.ts](src/host/oauth.ts)).
- `mcp_skill_unavailable`: the server is not connected, does not list that
  skill now, or its read failed, timed out or answered no text
  ([Skills](#skills)).

The entry checks answer `invalid_input` with
`The credential of <name> is an MCP sign-in token; only the sign-in of its own server uses it.`
for an entry naming an `MCP_TOKEN` credential, and
`The credential of <name> holds no secret.` when connecting finds no secret
([src/host/credentials.ts](src/host/credentials.ts)). The window shows each
message as it is in a toast ([src/client/api.ts](src/client/api.ts)).

### `default.skill-sources/v1` 1.0.0

The contract is `default`'s ([`default`](../../runtime/default/README.md)),
imported from `default/contracts`; this bundle is one of its providers
(cardinality `many`) ([src/host/index.ts](src/host/index.ts),
[src/host/skills.ts](src/host/skills.ts)).

- `list({ cwd }, call)` answers `{ skills }`: the skills of the call's
  Project's `connected` servers, in server order and each server's order,
  each as `{ group: serverSlug(server.name), name, description, reference }`,
  where `reference` is `<serverId>\n<uri>`. `cwd` is not used.
- `read({ reference }, call)` answers `{ origin, text }`: the text as
  `readSkill` reads it, and the origin
  ``From the MCP server "<name>" (`<uri>`). Its other files are not available.``
- Both refuse a call without a Project scope (`invalid_input`). `read`
  splits the reference at its first `\n`, refuses one with no `\n`, or with
  an empty server id or URI, with `invalid_input` and
  `The reference names no MCP server and skill.`, answers `mcp_server_missing` for a server the Project
  does not hold, and `mcp_skill_unavailable` as `readSkill` does.

### `mcp.server/v1` 1.1.0

The storage type of the servers ([Data and persistence](#data-and-persistence)),
defined with `defineStorageType` in [src/host/store.ts](src/host/store.ts)
and registered through `storage/v1.defineType` on activation.

### `MCP_TOKEN` credential kind

Registered through `secrets/v1.registerKind` on activation: one `secret`
(required), no optional field, label `MCP token`. It holds one secret an
OAuth sign-in stored ([src/host/credentials.ts](src/host/credentials.ts)).

### Tools and window elements

- Each tool of a connected server, registered with `tools/v1`
  ([Tools](#tools)).
- The custom elements `mcp-sidebar` and `mcp-group-action`, defined through
  `ui/v1`, and the pane `mcp-sidebar` registered in `layout.stack/v2`
  ([Client part](#client-part)).

## Contracts used

| Contract                                  | Part         | What for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/v1`                              | host         | Defines `mcp.server/v1`; `get`, `query`, `commit` of the documents ([src/host/store.ts](src/host/store.ts)). The process defines the type in `activate` and waits for `settled()` ([src/host/service.ts](src/host/service.ts)).                                                                                                                                                                                                                                                                                                           |
| `secrets/v1`                              | host, client | Registers `MCP_TOKEN`; resolves entry credentials and checks their kind (`resolve`, `describe`); creates, updates, deletes and lists the OAuth credentials ([src/host/credentials.ts](src/host/credentials.ts)). The window lists credentials and creates `API_TOKEN` ones ([src/client/api.ts](src/client/api.ts)). The process registers `MCP_TOKEN` through `context.registrations` in `activate` and reaches the rest through `routedSecrets` ([src/host/service.ts](src/host/service.ts), [src/host/routed.ts](src/host/routed.ts)). |
| `tools/v1`                                | host         | Registers and unregisters each server tool; reads `catalog()` to wait for a released name ([src/host/manager.ts](src/host/manager.ts)). The process goes through `routedTools` and answers calls as `ToolHandlerService` ([src/host/routed.ts](src/host/routed.ts), [src/host/main.ts](src/host/main.ts)).                                                                                                                                                                                                                                |
| `hooks/v1`                                | host         | `whenAvailable(runtime.hooks/v1)` to register the runtime hooks ([src/host/index.ts](src/host/index.ts), [src/host/manager.ts](src/host/manager.ts)).                                                                                                                                                                                                                                                                                                                                                                                     |
| `runtime.hooks/v1`                        | host         | `onPromptStartedHook`, `onProjectClosingHook`, `onProjectReadyHook` ([src/host/index.ts](src/host/index.ts)). The process registers the three in one hook table served as `HookHandlerService` ([src/host/service.ts](src/host/service.ts)).                                                                                                                                                                                                                                                                                              |
| `runtime/v2`                              | host         | `watch` for `projectDeleted` notices ([src/host/index.ts](src/host/index.ts)); the process uses `watchProjectDeletions` ([src/host/routed.ts](src/host/routed.ts)). The function `createdKey` of `runtime/contracts` gives the documents' order ([src/host/store.ts](src/host/store.ts)).                                                                                                                                                                                                                                                 |
| `runtime.lease/v1`                        | host         | `withLease` on the Project's sandbox to start a `stdio` process ([src/host/open.ts](src/host/open.ts)); the process uses `routedMcpLease` ([src/host/lease.ts](src/host/lease.ts)).                                                                                                                                                                                                                                                                                                                                                       |
| `runtime.attachments/v1`                  | host         | `attach` an image a tool result carries ([src/host/tools.ts](src/host/tools.ts)); the process uses `routedAttach` ([src/host/routed.ts](src/host/routed.ts)).                                                                                                                                                                                                                                                                                                                                                                             |
| `log/v1`                                  | host         | Warnings and errors listed in [Errors and failure behavior](#errors-and-failure-behavior).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ui/v1`                                   | client       | Defines the two custom elements ([src/client/index.ts](src/client/index.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `layout.stack/v2`                         | client       | Registers the MCP pane ([src/client/index.ts](src/client/index.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `workspace.selection/v1`                  | client       | Follows the selected Project ([src/client/index.ts](src/client/index.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `doric.browser/v1`, `doric.connection/v1` | client       | Opens the authorization URL; resubscribes the watch after a reconnection ([src/client/api.ts](src/client/api.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                        |

The client part reaches `workspace.selection/v1` and `layout.stack/v2`
through structural copies narrowed to what it calls
([src/client/peers.ts](src/client/peers.ts)).

## Data and persistence

### `mcp.server/v1` documents

One document per server, keyed by the server's `id`, with the index
`byProject` on `[projectId, createdKey]`; a Project's servers are read in
ascending order of that index, 1000 per page
([src/host/store.ts](src/host/store.ts)). The schema is strict:

```ts
{
  id: string;            // UUID
  projectId: string;     // UUID
  name: string;
  enabled: boolean;
  transport: McpTransport;
  createdKey: string;    // runtime's createdKey(createdAt, id)
  createdAt: string;     // ISO time
  updatedAt: string;     // ISO time
  oauth?: {
    clientInformation?: { client_id: string; ... };  // never a client_secret
    discoveryState?: {
      authorizationServerUrl: string;
      resourceMetadataUrl?: string;
      resourceMetadata?: unknown;
      authorizationServerMetadata?: unknown;
    };
    tokenType?: string;
    scope?: string;
    accessCredentialId?: string;
    refreshCredentialId?: string;
    clientSecretCredentialId?: string;
  };
}
```

No secret is stored in a document. An entry's literal `value` is stored as
typed; a `credentialId` entry stores only the id.

Every read-change-write of one document runs under that server's lock, and
every check of a Project's names with the write it allows runs under that
Project's lock; a Project task may take a server lock, a server task never
takes its Project's
([src/host/store.ts](src/host/store.ts)).

### OAuth credentials

The access token, the refresh token and a client secret are `MCP_TOKEN`
credentials named `mcp:<serverId>:access`, `mcp:<serverId>:refresh` and
`mcp:<serverId>:client`; the document keeps their ids. Writing a secret
updates the stored credential, else creates it, else (on
`credential_name_taken`) updates the `MCP_TOKEN` credential of that name. A
token set without a refresh token deletes the stored refresh credential; a
client without a secret deletes the client-secret credential. A credential
deleted elsewhere reads as absent, so the server asks for a sign-in again
([src/host/credentials.ts](src/host/credentials.ts)).

OAuth state is written only while the server still has the URL it was read
for: a save for a server whose URL changed stores nothing and fails, and an
invalidation for another URL does nothing
([src/host/credentials.ts](src/host/credentials.ts),
[src/host/oauth.ts](src/host/oauth.ts)).

### Live state

Connections, statuses, tool and skill views, the last five stderr lines of a
`stdio` process, and waiting sign-ins live in host memory only; after a
restart every enabled server reads as `idle` until something connects it
([src/host/manager.ts](src/host/manager.ts),
[src/host/oauth.ts](src/host/oauth.ts)).

## Behavior

### When servers connect and stop

- `watch` connects the Project's enabled servers
  ([src/host/index.ts](src/host/index.ts)).
- A starting prompt (`onPromptStartedHook`) connects its Project's servers
  and waits at most 10 seconds for them; a failure is logged and never fails
  the prompt ([src/host/index.ts](src/host/index.ts)).
- A ready Project (`onProjectReadyHook`) connects its servers that are
  `waiting-for-sandbox`, once any attempt in progress ends
  ([src/host/manager.ts](src/host/manager.ts)).
- `create`, `update` and `finishSignIn` connect the server as
  [Methods](#methods) states ([src/host/index.ts](src/host/index.ts),
  [src/host/manager.ts](src/host/manager.ts)).
- A closing Project (`onProjectClosingHook`) stops its servers, which read as
  `idle` again; a connection that its listing began before the close starts
  none ([src/host/manager.ts](src/host/manager.ts)).
- A deleted Project (`runtime/v2` notice `projectDeleted`) loses its servers:
  their credentials and documents are deleted, they stop, their waiting
  sign-ins are cancelled; a failure is logged as an error
  ([src/host/index.ts](src/host/index.ts)).
- A server removed or disabled while a `watch` or a prompt start listed it does not start; one removed or disabled while it
  connected is stopped once its attempt ends
  ([src/host/manager.ts](src/host/manager.ts)).
- At most one connection per server exists: a new start ends the previous
  attempt and connection first ([src/host/manager.ts](src/host/manager.ts)).
- Deactivation stops every connection and process, unregisters every tool,
  cancels every waiting sign-in and unregisters the storage type and the
  credential kind ([src/host/index.ts](src/host/index.ts)).

### A connection attempt

1. The status becomes `connecting`.
2. The entries are resolved through `secrets/v1`
   ([Entries](#entries-and-secrets)).
3. The transport opens ([`http`](#http), [`stdio`](#stdio)). A `stdio`
   server without a lease ends here as `waiting-for-sandbox`.
4. The tools are listed (every page of `tools/list`) and registered
   ([Tools](#tools)).
5. The skills are listed ([Skills](#skills)); a failed listing is logged and
   leaves the server with no skills.
6. The status becomes `connected`.

A failure ends the attempt as `needs-sign-in` when it is an authorization
failure (the background OAuth provider asks for a sign-in, the SDK's
`UnauthorizedError`, or an HTTP 401 or 403 of Streamable HTTP), else as
`error` with the masked message ([src/host/manager.ts](src/host/manager.ts),
[src/host/open.ts](src/host/open.ts)).

Every connection sends `initialize` with `clientInfo` from
`mcpClientInfoOf(transport)` and declares the capability
`extensions: { 'io.modelcontextprotocol/skills': {} }`. A failed connect
closes its client ([src/host/open.ts](src/host/open.ts)).

### `http`

The host reaches the server over Streamable HTTP at `url`, each request
carrying the server's resolved headers and the background OAuth provider. A
failure other than authorization or abort retries once over HTTP+SSE with a
new client; when both fail, the message is
`<Streamable HTTP failure> (over HTTP+SSE: <SSE failure>)`
([src/host/open.ts](src/host/open.ts)).

### `stdio`

The server runs only in the Project's sandbox, never on the host: inside
`runtime.lease/v1.withLease`, the sandbox's `start` runs
`[command, ...args]` with `cwd` when set, `env` as `NAME=value` of the
resolved entries, and `tty: false` ([src/host/open.ts](src/host/open.ts)).

- A lease answer `ready` connects; `pending` or `unavailable` leaves the
  server `waiting-for-sandbox`; `missing` fails with
  `The Project no longer exists, so its stdio MCP server cannot start.`;
  `expired` fails with
  `The Project has ended, so its sandbox cannot run a stdio MCP server.`. A
  client connected inside a lease that did not answer `ready` is closed, so
  its process ends.
- A sandbox without `start` fails with
  `The Project sandbox cannot keep a process running, so it cannot run a stdio MCP server.`.
- JSON-RPC is newline-delimited: each message is written to stdin followed by
  a newline, and each complete stdout line is parsed as one message; a line
  that does not parse is reported to the client as an error and dropped. The
  transport starts once; closing it terminates the process; its close notice
  fires once, whether it was closed or the process exited
  ([src/host/stdio.ts](src/host/stdio.ts)).
- Each stderr line drops a trailing `\r` and is masked; a line over 4096
  characters keeps `…` and its last 4096 characters, the cut moved so a
  secret is never split. An unterminated line longer than twice the larger
  of 4096 and the longest secret keeps only its end, after `…`; an
  unterminated last line is emitted when the process ends. The last five
  lines are kept per server
  ([src/host/stdio.ts](src/host/stdio.ts),
  [src/host/manager.ts](src/host/manager.ts)).
- A process that exits on its own puts the server in `error` with
  `The MCP server closed the connection.`, or
  `The MCP server closed the connection: <last stderr line>`
  ([src/host/manager.ts](src/host/manager.ts)).

### Entries and secrets

- A header or environment entry is a literal `value` or the `credentialId`
  of a stored credential whose `secret` is read through `secrets/v1` each
  time the server connects. Only the connecting server's own entries are
  resolved; a later entry of the same name wins
  ([src/host/credentials.ts](src/host/credentials.ts)).
- An entry that names an `MCP_TOKEN` credential is refused with
  `invalid_input` on `create` and `update` (checked through `describe`; a
  credential that is not stored passes) and when the server connects. A
  credential that holds no secret, or that cannot be resolved, fails the
  connection ([src/host/credentials.ts](src/host/credentials.ts),
  [src/host/index.ts](src/host/index.ts)).
- A server's status message, its skill-read failures, its stderr lines and
  the connection log fields named in
  [Errors and failure behavior](#errors-and-failure-behavior) show each
  non-empty secret its entries resolved to as `[REDACTED]`, longest first ([src/host/credentials.ts](src/host/credentials.ts),
  [src/host/manager.ts](src/host/manager.ts)).

### Tools

- While a server is connected, each of its tools is registered with
  `tools/v1` under the server's Project, with `alwaysAvailable: false` and
  `order: 1000` ([src/host/manager.ts](src/host/manager.ts)).
- Its name is `mcp__<slug>__<tool>` with every character outside
  `[a-zA-Z0-9_-]` turned into `_`. A name over 64 characters, or one another
  tool of the same server already took, keeps its first 55 characters and
  ends with `_` and the first 8 hex digits of the SHA-256 of the MCP tool
  name ([src/host/tools.ts](src/host/tools.ts)).
- The definition carries the server's input schema verbatim as
  `inputSchema`, accepts any object as input, outputs a string, is not
  strict, declares no `resultModalities`, and is described by the tool's
  `description`, else its `title`. An
  input schema that is not a JSON object throws `invalid_schema`, and the
  tool is left out and logged, as is a tool whose name `tools/v1` refuses
  ([src/host/tools.ts](src/host/tools.ts),
  [src/host/manager.ts](src/host/manager.ts)).
- A call runs `tools/call` under the prompt's abort signal with a 300-second
  timeout. Its result reads as text: the blocks in order, separated by a
  blank line. Text stays text; an image whose media type the runtime accepts
  is attached to the Project as `image.<subtype>` and reads as its reference
  line; an image the Project refuses (`invalid_input`) or cannot show, an
  audio clip and a binary resource read as one bracketed line naming them:
  `[An image (<type>) the conversation cannot show.]` for an image whose
  type the runtime does not accept,
  `[An image (<type>) the Project refused to keep.]`,
  `[An audio clip (<type>) the conversation cannot play.]` and
  `[A binary resource <uri> (<type, else "unknown type">) the conversation cannot show.]`.
  A resource link reads as `[<title, else name>](<uri>)`. Brackets and line
  breaks inside a label become a space. An embedded text resource reads as
  its text. A result with no content and `structuredContent` reads as that
  JSON. A result flagged `isError` fails with `mcp_tool_failed` and that
  text, or `The MCP tool <name> failed.` when it is empty
  ([src/host/tools.ts](src/host/tools.ts)).
- A call that fails without an MCP answer, outside an aborted prompt, checks
  the connection: an authorization failure moves the server to
  `needs-sign-in`; otherwise a `ping` (10-second timeout) runs, and a failed
  ping moves it to `needs-sign-in` on authorization, else connects it again
  ([src/host/manager.ts](src/host/manager.ts)).
- A `notifications/tools/list_changed` lists the tools again: an unchanged
  tool (same JSON) keeps its registration, a removed or changed one is
  unregistered, and a new name freed under the Project waits up to 5 seconds
  for `tools/v1` to stop listing it before it is registered again. The
  server's `tools` lists exactly what is registered, in the server's order
  ([src/host/manager.ts](src/host/manager.ts)).
- The tools are unregistered whenever the server leaves `connected`.

### Skills

- A server's skills are listed only when it declares
  `io.modelcontextprotocol/skills` in its capabilities: every page of
  `skills/list` (following `nextCursor`), each entry read as its `uri` and
  its `frontmatter.name` and `frontmatter.description`. An entry missing one
  of those fails the listing ([src/host/skills.ts](src/host/skills.ts)).
- `readSkill` and the skill source's `read` refuse a server that is not
  `connected` (`The MCP server <name> is not connected.`) and a URI the
  server does not list now (`The MCP server <name> does not list the skill
<uri>.`); otherwise they run `resources/read` of the URI with a 30-second
  timeout and answer the first content entry with `text`. A failure, timeout,
  abort or textless answer gives `mcp_skill_unavailable` with
  `The MCP server <name> could not read the skill <uri>: <masked reason>`.
  Nothing is cached, and no state changes
  ([src/host/manager.ts](src/host/manager.ts),
  [src/host/skills.ts](src/host/skills.ts)).
- A skill is read with no per-skill approval or digest check: what the
  agent does with it runs in the Project's sandbox
  ([src/host/skills.ts](src/host/skills.ts)).

### OAuth

`http` servers use the MCP SDK's OAuth flow (`auth`) through a provider over
the vault ([src/host/oauth.ts](src/host/oauth.ts)).

- **Background.** A connection's provider never registers a client and never
  redirects: either raises `SignInRequired`, which reads as `needs-sign-in`.
  It uses the stored tokens and refreshes them; its redirect URL is
  `http://127.0.0.1/callback` only so the SDK takes the authorization-code
  path.
- **Stored state.** Tokens stored without a `tokenType` read as `Bearer`
  ([src/host/credentials.ts](src/host/credentials.ts)).
- **Refresh.** One refresh runs at a time per provider: each waits for the
  previous one (at most 30 seconds) and sends the latest stored refresh
  token. An invalidation of tokens keeps tokens that a refresh of this
  provider did not send, since they are newer than those that failed.
- **Discovery.** It fails when the authorization server publishes no
  metadata or no PKCE `S256`. The `resource` is always sent: the server's
  URL, or the protected-resource metadata's `resource` when allowed for it,
  else the sign-in fails. The PKCE verifier lives in memory only.
- **Client registration.** `client_name` is the transport's `clientName`, else
  `Doric`; `redirect_uris` is the loopback callback; `grant_types`
  `authorization_code` and `refresh_token`; `response_types` `code`;
  `token_endpoint_auth_method` `none`; `scope` the transport's `scopes`
  joined by spaces when set. Client authentication at the token endpoint
  follows the registration and metadata: HTTP Basic, the secret in the body,
  or the client id alone.
- **`signIn`.** One start or cancel per server runs at a time. It cancels the
  server's waiting sign-in, deletes its stored tokens, binds a callback on
  `127.0.0.1` on a free port, and drops a stored client whose redirect URIs
  lack that callback or whose `client_name` differs. It then runs `auth` with
  the transport's `scopes` (which take precedence over the ones the server
  names) and a random 32-byte `state`, and answers the authorization URL. A
  callback that cannot start or a preparation that fails gives
  `mcp_signin_failed`; a server whose URL changed, a cancelled call or a
  deactivated bundle gives `mcp_signin_aborted`.
- **Waiting.** One sign-in per server waits; a newer `signIn` of the same
  server replaces it, and another server's is left alone. A sign-in is
  cancelled ten minutes after its `signIn`, even while a `finishSignIn` waits
  on it (which then answers `mcp_signin_aborted`); an `update` that changes the transport kind
  or URL, `remove`, a deleted Project and deactivation cancel it. Each
  cancellation closes its callback.
- **`finishSignIn`.** It waits for the redirect, whose `state` the callback
  checks; a cancelled call cancels the sign-in. It refuses an error answer, a
  redirect whose `iss` differs from the metadata's `issuer` (or that lacks
  `iss` when the metadata sets
  `authorization_response_iss_parameter_supported`), and a redirect with no
  code, all as `mcp_signin_failed`. It exchanges the code, stores the tokens
  and the host reconnects the server; tokens for a URL the server does not
  have are not stored (`mcp_signin_aborted`). A `finishSignIn` ends the
  waiting sign-in whatever its outcome; a later one answers
  `mcp_signin_not_started` until a new `signIn`.

## Client part

[src/client/index.ts](src/client/index.ts) defines the elements, registers
the pane whenever `layout.stack/v2` is available, and keeps one
`mcp/v1.watch` open for the Project `workspace.selection/v1` selects (none
while no Project is selected); a new Project replaces the watch.

- **Pane.** `{ id: 'mcp-sidebar', order: 20, title: 'MCP', tag:
'mcp-sidebar', headerTag: 'mcp-group-action', collapsible: true,
initiallyOpen: false }`. The rows are the watched servers in creation
  order: three skeleton rows until the first delivery, then one row per
  server with its status icon and its tool count when connected
  (`1 tool`, `<n> tools`) or its status label otherwise (`Disabled`, `Idle`,
  `Connecting…`, `Connected`, `Sign in required`, `Waiting for sandbox`,
  `Error`). A row's title joins the name, the label and the message with
  `—`. A row of
  an `http` server in `needs-sign-in` shows a `Sign in` link, disabled while
  its sign-in is being prepared. A remove control appears on hover or
  keyboard focus. An empty loaded pane shows `No MCP servers`; a failed
  watch shows the alert `Unable to load MCP servers`
  ([src/client/elements.tsx](src/client/elements.tsx)).
- **Header.** The `Add MCP server` control, disabled while no Project is
  selected, opens the dialog for the Project selected when it opened
  ([src/client/elements.tsx](src/client/elements.tsx)).
- **Server dialog.** Name, transport (`HTTP` or `stdio`), and either URL and
  headers, or command line and environment; for an edited server, the tables
  of its tools and its skills, filtered by name or description; an Advanced
  section with the OAuth client name and scopes (`http`), the working
  directory (`stdio`), and the MCP client name and version; and `Enabled`.
  The command line splits as a POSIX shell quotes words, with no expansion,
  and a stored command is written back quoted the same way. Save checks the
  draft with `mcpServerInputSchema` and marks the fields to correct; a host
  failure keeps the dialog open and shows a toast
  ([src/client/server-dialog.tsx](src/client/server-dialog.tsx),
  [src/client/draft.ts](src/client/draft.ts),
  [src/client/catalog-table.tsx](src/client/catalog-table.tsx)).
- **Credentials.** An entry's key button picks a stored credential of any
  kind but `MCP_TOKEN`; `New credential…` stores a typed token as an
  `API_TOKEN` credential and selects it
  ([src/client/api.ts](src/client/api.ts),
  [src/client/server-dialog.tsx](src/client/server-dialog.tsx)).
- **Remove.** A confirmation dialog, then `remove`; a failure shows a toast
  ([src/client/elements.tsx](src/client/elements.tsx)).
- **Sign-in.** `signIn`, then `doric.browser/v1.open` of the URL; when the
  browser does not open, a toast keeps the link with a `Copy link` action.
  Then `finishSignIn`; a failure shows a toast. A newer sign-in of the same
  server replaces the older one's toasts, and the older one ends silently
  ([src/client/sign-in.ts](src/client/sign-in.ts)).
- **Watch recovery.** `Watch` is a resumable stream (slice S65c), so a stream
  that ends with `generation_lost` is opened again by the SDK from its cursor
  and the pane does nothing. A watch that ends with `disconnected` or
  `unavailable` subscribes again when `doric.connection/v1` reports
  `connected`, or after one second when the connection stayed up; any other
  failure ends it with `The Project's MCP servers could not be read.`
  ([src/client/api.ts](src/client/api.ts)).
- **Stylesheet.** [src/client/styles.css](src/client/styles.css) scans no
  source file (`source(none)`) and names every utility class it emits in one
  `@source inline(…)` list, so it re-emits no class another bundle's sheet
  relies on in the window's cascade. A class used in the client part and
  missing from that list is not emitted.

## Configuration

A server's settings are its `McpServerInput`; nothing else is configurable.
The fixed limits are the timeouts and sizes listed in [Limits](#limits).

## Limits

- Name: 1–64 characters; slug: at most 20 characters; tool name: at most 64
  characters ([src/contracts/index.ts](src/contracts/index.ts),
  [src/host/tools.ts](src/host/tools.ts)).
- A prompt start waits at most 10 seconds for the servers; a tool call takes
  at most 300 seconds; a connection check pings for at most 10 seconds; a
  skill read takes at most 30 seconds; a waiting sign-in lasts at most ten
  minutes; a released tool name is waited for at most 5 seconds
  ([src/host/index.ts](src/host/index.ts),
  [src/host/manager.ts](src/host/manager.ts),
  [src/host/skills.ts](src/host/skills.ts),
  [src/host/oauth.ts](src/host/oauth.ts)).
- The OAuth callback is a loopback on the host's `127.0.0.1`: a sign-in
  completes only where the browser's `127.0.0.1` is the host's
  ([src/host/oauth.ts](src/host/oauth.ts)).
- A sign-in needs dynamic client registration: an authorization server
  without it, or one that accepts only clients created in its own console,
  cannot be signed in to ([src/host/oauth.ts](src/host/oauth.ts)).
- A `stdio` process gets the sandbox image's environment plus its own
  entries, nothing else from the host. It runs as the sandbox's user, so it
  can read what any process of that user can: the GitHub credentials the
  runtime gives the sandbox
  ([git-credentials.ts](../../runtime/runtime/src/host/domain/git-credentials.ts)),
  and `/proc/<pid>/environ` of another `stdio` server's process
  ([src/host/open.ts](src/host/open.ts)).

## Errors and failure behavior

- Contract errors are listed under [Error codes](#error-codes).
- A failure that has no caller is logged through `log/v1` and never thrown
  ([src/host/index.ts](src/host/index.ts),
  [src/host/manager.ts](src/host/manager.ts),
  [src/host/oauth.ts](src/host/oauth.ts)):
  - warn `An MCP server could not apply its configuration` (`serverId`);
  - warn `The MCP servers of a Project could not connect` (`projectId`);
  - error `The MCP servers of a deleted Project could not be removed`
    (`projectId`);
  - warn `The MCP servers waiting for a sandbox could not connect`
    (`projectId`);
  - warn `An MCP watcher failed`;
  - warn `The MCP servers could not be read for their watchers`
    (`projectId`);
  - warn `An MCP tool was skipped` (`serverId`, `tool`);
  - warn `The MCP server tools could not be listed again`,
    `The MCP server skills could not be listed`,
    `An MCP server could not connect again` (`serverId`);
  - warn `An MCP connection did not close`,
    `The MCP sign-in callback did not close`.
- Each carries an `error` field. `An MCP tool was skipped`,
  `The MCP server tools could not be listed again`,
  `The MCP server skills could not be listed`,
  `An MCP server could not connect again` and
  `An MCP connection did not close` mask the connection's secrets in it; the
  others carry the error's message as it is.

## Build and test

```console
npx nx run bundle-mcp:typecheck
npx nx run bundle-mcp:build
npx nx run bundle-mcp:test
```

`test` builds the bundle first, then compiles and runs with `node --test`:

- [tests/](tests/): the host part, activated by
  [tests/support/world.ts](tests/support/world.ts) beside fakes of every
  contract it requires, against real SDK MCP servers
  ([tests/support/mcp-server.ts](tests/support/mcp-server.ts)), a fake OAuth
  authorization server ([tests/support/oauth-server.ts](tests/support/oauth-server.ts))
  and a fake sandbox ([tests/support/sandbox.ts](tests/support/sandbox.ts));
  `styles-cascade.test.ts` reads the built `dist/client/styles.css`.
- [tests/client/](tests/client/): the client part in `happy-dom`.

[stories/](stories/) holds the pane and dialog stories, wrapped by
[.storybook/preview.tsx](.storybook/preview.tsx).
