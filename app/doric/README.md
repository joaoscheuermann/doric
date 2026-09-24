# Doric desktop

`doric-app` owns the Electron main process. It loads `doric-renderer`,
communicates with the local Direct host at `http://127.0.0.1:3000` over HTTP and
Socket.IO, and exposes only named Project and Thread operations, three read-only
Project filesystem reads (one directory listing, one bounded file content read,
and the workspace Git diff), the host configuration, an event subscription for
one selected Thread and one selected Project, and semantic connection status
through a sandboxed, origin-checked preload bridge. The
`/status`, `/threads`, and `/projects` namespaces share one process-long
Engine.IO connection; the renderer never accesses any transport directly.

The `config` namespace crosses the same boundary: `config.get` reads the host
configuration, which is credential-free except for GitHub's username, email and
write-only token — a token is answered as `hasToken` and never as itself — and
`config.update` replaces the whole configuration with the one it is given, so a
Settings surface needs no HTTP client of its own. The GitHub block is guarded
before it is sent: it carries exactly `username`, `email` and an optional
`token`, where an absent or `null` token keeps the stored one, `''` clears it and
any other value replaces it. A token is never logged, never named in an error
message and never part of what `config.get` answers with.

Every Project filesystem call validates its workspace-relative path before it
reaches the host — no absolute path, no `..` segment, no NUL character — and
returns the host's lease states (`pending` with the host's `Retry-After` hint,
`expired`, `unavailable`, `missing`) as data instead of throwing, so the
renderer can explain a Project whose sandbox is not usable yet.

At startup a frameless, square, dark splash window shows the centered `Doric`
name while the main process waits for the local Direct API to answer. The splash
stays visible for at least five seconds, and the dark workspace window replaces
it once that window is ready to show.

On macOS the workspace window keeps always-visible native traffic lights over a
custom draggable renderer title bar. A segmented footer follows the same
resizable boundary and reports `Connected` or `Disconnected` from the main
process's `/status` Socket.IO subscription.

## Development

Start the Direct backend first, then run both desktop development processes from
the repository root:

```console
npm run doric:dev
```

Build, test, or package the desktop boundary directly:

```console
npx nx run doric-app:typecheck
npx nx run doric-app:lint
npx nx run doric-app:test
npx nx build doric-app
npm run nxe:package:app
```

Project and Thread deletion terminates the resource before retrying physical
deletion until the asynchronous lifecycle reaches a terminal state.
