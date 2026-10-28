# MCP bundle

`mcp` connects a Project to MCP (Model Context Protocol) servers and gives
their tools to that Project's prompts. Servers are per Project, never global:
a server belongs to the Project it was created in, and its tools are listed
only to calls of that Project.

It is a feature bundle with a host part (the servers, their connections and
the OAuth sign-in) and a client part (the sidebar's MCP pane), loaded by the
`bundle` platform. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Contract:** `mcp/v1` 1.1.0 (host): `list`, `create`, `update`, `remove`,
  `watch`, `signIn` and `finishSignIn`, each reachable from a desktop window,
  and the host-only `readSkill`, over the servers of the Project of
  `call.scope.projectId`. A call without a Project scope is refused
  (`invalid_input`). The shapes and error codes live
  in [`src/contracts/index.ts`](src/contracts/index.ts) (`mcp/contracts`).
- **Storage type:** `mcp.server/v1`, one document per server, listed per
  Project in creation order.
- **Credential kind:** `MCP_TOKEN`, one secret an OAuth sign-in stored.
- **Tools:** each tool of a connected server, registered with `tools/v1`
  under the server's Project as `mcp__<server slug>__<tool>` (names that
  sanitize alike or run over 64 characters end with a hash of the MCP name).
  The slug folds `_` like any other character outside `[a-z0-9-]`, so it
  never holds `__` and two servers never name a tool alike.
  The server's input schema is what the model sees, verbatim; the tool is not
  strict, and the server validates the arguments.
- **Skills:** the skills a connected server lists through the MCP Skills
  extension (`io.modelcontextprotocol/skills`, `skills/list`), on its view by
  URI, name and description; listed only when the server declares the
  extension. A failed listing is logged and leaves the server connected, with
  no skills. The default agent lists the connected servers' skills and loads
  one on demand through the host-only `readSkill`: a `resources/read` of its
  URI when asked, never before, for a URI the connected server lists now
  (`mcp_skill_unavailable` otherwise, or when the read fails, passes 30
  seconds or answers no text). Doric runs MCP skills without SEP-2640's
  per-skill approval or digest checks: execution stays in the Project's
  sandbox.
- **Window:** the client part registers the sidebar's MCP pane
  (`layout.stack/v1`): the selected Project's servers with their status and
  tool count over `mcp/v1.watch`, and the dialogs that add, edit, remove and
  sign in to them; the edit dialog lists the server's tools and skills after
  its headers or its environment. A header or variable is a typed value or a
  credential picked with the key button, from `secrets/v1` or stored there as
  a new `API_TOKEN`.

## Servers

- **`http`.** Reached from the host over Streamable HTTP; a server that
  fails it for another reason than authorization is tried again over the
  older HTTP+SSE transport, with a new client; when both fail, the status
  gives the Streamable HTTP failure, then the fallback's. Requests carry the
  server's own headers only.
- **`stdio`.** Runs only in the Project's sandbox, started through
  `runtime.lease/v1.withLease` and `Sandbox.start` on the sandbox the Project
  holds now; it is never a host process. Without a lease the server waits
  for the sandbox (`waiting-for-sandbox`) and connects once the Project is
  ready (`runtime.hooks/v1.onProjectReadyHook`), or at its next watch or
  prompt start; a lease lost while the server started ends its process and
  leaves it waiting too. A Project that no longer exists or has ended, or a
  sandbox that cannot keep a process running, leaves it in `error`. JSON-RPC
  is newline-delimited over the process's stdin and stdout; its stderr feeds
  the error message, masked, each line at most its last 4096 characters.
- **Entries.** A header or environment entry is a literal value or the id of
  a stored credential, whose secret is read when the server connects. Each
  server receives its own entries alone, and only its own credentials are
  resolved: an entry naming an `MCP_TOKEN` credential (another server's
  sign-in) is refused (`invalid_input`) on `create`, `update` and connect.
  Every message about a server masks its secrets.
- **Life.** `watch` connects every enabled server of its Project that is not
  connected; a starting prompt waits up to ten seconds for its Project's
  servers; a closing Project stops them (they read as `idle` again); a
  deleted Project loses its servers and their `MCP_TOKEN` credentials. A
  server removed, disabled or whose Project closed while `watch` or a
  prompt start listed it does not start. Tools are registered while a
  server is connected and unregistered whenever it leaves that state;
  `tools/list_changed` keeps the registration of each unchanged tool and
  replaces the others, a changed one once tools/v1 no longer lists its old
  registration. A tool whose schema is unusable or whose name tools/v1
  refuses is left out; the server's view lists what is registered.
  Deactivation closes every connection and process and unregisters every
  tool.
- **Lost connections.** A tool call that fails without an MCP answer moves
  its server out of `connected`: to `needs-sign-in` when the server asks
  for authorization no stored token gives, else, once a ping fails too, it
  connects again (a server that forgot the session gets a new one) or ends
  in `error`.

## OAuth

`http` servers that answer 401 with protected-resource metadata use the
SDK's OAuth flow. A background connection never registers a client nor opens
anything: it uses and refreshes stored tokens, and otherwise reports
`needs-sign-in`. `signIn` binds a loopback callback on `127.0.0.1` (a fresh
port), registers a client (`token_endpoint_auth_method: none`) when the
stored one does not name that redirect, and answers an authorization URL
with PKCE `S256` and the server as the `resource`; an authorization server
without metadata or without `S256` fails the sign-in. `finishSignIn` waits
for the redirect (the callback checks `state`), refuses an `iss` other than
the advertised issuer, exchanges the code and reconnects the server. One
sign-in per server waits at a time, as for the Claude login: a newer one of
the same server replaces it (another server's is left alone), one nobody
finishes is cancelled after ten minutes, and changing the server's transport
kind or URL, removing it, or deactivation cancels it. Access, refresh and
client secrets are `MCP_TOKEN` credentials named `mcp:<serverId>:access`,
`:refresh` and `:client`; the document keeps only their ids and the
non-secret OAuth state. Changing a server's transport kind or URL, or
removing it, deletes them, and tokens earned for the former URL afterwards
are never stored. A connection refreshes one token at a time, each refresh
sending the latest stored refresh token.

## Limits

- The OAuth callback is a loopback on the host, as for the Claude login: it
  reaches the host only where the browser's `127.0.0.1` is the host's.
- A `stdio` process gets the sandbox image's environment plus its own
  entries, nothing else from the host. It runs as the sandbox's user, so the
  sandbox's existing exposures apply to it: the runtime's git token file,
  and `/proc/<pid>/environ` of other processes of the same user (another
  `stdio` server's entries included).

## Development

```console
npx nx build bundle-mcp
npx nx typecheck bundle-mcp
npx nx test bundle-mcp
```
