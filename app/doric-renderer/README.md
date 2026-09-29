# Doric renderer

`doric-renderer` is the React, Tailwind CSS, Radix, and shadcn/ui surface loaded
by `doric-app`. Its compact sidebar creates, selects, renames, and deletes named
Projects and recursive Threads. The selected Thread displays its durable event
history and accepts serial prompts through a bare composer that shows the
Thread's own log verbatim while the conversation is rebuilt by hand. The document
starts with shadcn's `.dark` theme before React renders, using the repository's
warm neutral and green-accent OKLCH palette.

The custom title bar keeps native macOS traffic lights visible and owns the
sidebar toggle. The sidebar uses shadcn's `Resizable` panel and can be collapsed
or dragged between its configured minimum and maximum widths.

The renderer has no direct network access to Doric. It uses the semantic
`window.doric` API exposed by the Electron preload boundary.

## Conversation architecture

- `threads.watch(id, afterSequence, listener)` supplies the initial durable
  event snapshot and ordered live events. The renderer projects those events by
  `promptId`; it does not persist a second message history.
- The surface above that projection is, for now, deliberately bare: a prompt
  input, a submit button, and the Thread's own log rendered verbatim as JSON,
  with no styling. `use-thread-chat.ts` owns the subscription, the log and the
  sending, and the surface only reads them. It is a stand-in while the rendering
  of prose, reasoning, tool calls, delegated input and comments is rebuilt by
  hand, so it promises no shape yet for any of them.
- `projects.watch(projectId, listener)` mirrors the selected Project's tree, so a
  Thread created by an agent appears in the sidebar without a reload.
- The Project's sandbox is a right-hand panel (`ProjectFilesSidebar`) with a Files
  tree and a Changes view. It belongs to the Project rather than to the selected
  Thread, it only reads, and it holds every state a read can answer with —
  `pending` with the host's retry hint, `expired`, `unavailable`, `missing`, a
  refused path — as data, so an unusable sandbox is explained instead of failing.
  The panel starts open, its tabs sit in its header in place of a title, and its
  toggle stays at the window's right corner whether the panel is expanded or
  collapsed (collapsed the panel is not mounted at all, and the main header
  carries the control that reopens it).
  `use-project-files.ts` owns the tree, the expansion, the open file and the
  diff. The whole tree arrives in one read through `projects.tree`, so expanding
  a directory reads nothing: `expanded` is view state over a tree already held,
  and only a file's content is read on demand, when it is opened. The diff is
  read only when the changes view is first shown, and it lists every Git
  repository the workspace tree holds: each repository's root path is a sticky
  header (rendered `.` for the workspace root) over that repository's own rows and
  its own diff, a repository with nothing changed is not shown, and a workspace
  with no repository at all says so. There is no watcher: the panel
  re-reads on its own refresh, and on `useThreadChat`'s `writes` growing, which
  counts the finished `write`, `edit` and `terminal` calls in the Thread's log
  (`projector.ts`). `domain/files.ts` holds the path rules, the diff
  classification and the sentences the states show, and is covered by
  `tests/files.test.ts`.
- Selecting a file opens the file viewer (`components/organisms/file-viewer.tsx`)
  as a resizable division of its own between the conversation and the sandbox
  panel, so the tree it was opened from stays where it is. Its header names the
  file and carries the one control it has — closing it, at the right corner — and
  its footer states the chain the file was reached through, where a chain too
  deep for that row collapses its middle behind one trigger (`FileBreadcrumb`,
  from `collapsedPath`). Closing it unmounts the division entirely, so a closed
  viewer takes no width and reports nothing.
- `projects.tree(projectId, path?)` is the whole sandbox tree in one request,
  with each directory's own entries nested under `children` and no per-file
  `size`, because one recursive walk measures nothing: that is what makes the
  whole tree cheap to read. `projects.files(projectId, path?)` stays the single
  directory level it always was, with sizes, and is what other callers keep.
- The open file's text is the Monaco editor in read-only mode
  (`components/molecules/code-view.tsx`): no minimap, no line highlight, no
  wrapping, and the theme taken from the document's own `.dark` class, because
  nothing switches it after startup. `domain/files.ts`'s `fileLanguage` names
  the language from the path's extension alone — TypeScript, JavaScript,
  Markdown, CSS, HTML, XML, YAML, Shell, SQL, Python and Rust — and `plaintext`
  for everything else, JSON included: Monaco serves JSON as a worker-backed
  language service, and this view bundles no language service at all. Only the
  editor's own worker is bundled, as one same-origin chunk, so the packaged
  policy's `script-src 'self'` still needs no `worker-src` exception. The
  editor is created once per mounted file and disposed when the view unmounts,
  and a later text reaches the model it already holds rather than a new editor.
  The editor is what the renderer's main bundle now mostly consists of.

State that the live subscription and the persisted selection own is isolated in
`use-project-events.ts` and `use-persisted-selection.ts`, and the conversation's
own in `hooks/use-thread-chat.ts`, which keeps `app.tsx` on the composition and
layout side.

The preload conversation contract also exposes
`threads.prompt(id, markdown): Promise<{ promptId: string }>`,
`threads.rewind(id, promptId, markdown): Promise<{ promptId: string }>`, and
`threads.get(id): Promise<Thread | undefined>`, where `undefined` means the
Thread no longer exists. `ThreadUpdate` is a discriminated union with
`snapshot`, `event`, `updated`, `deleted`, and safe `error` variants, and
`ProjectUpdate` with `snapshot`, `thread-updated`, `thread-deleted`,
`project-updated`, `project-deleted`, and safe `error`. Both subscriptions share
the Electron process's single Engine.IO connection.

The sandbox surface reads through
`projects.tree(projectId, path?)`, `projects.file(projectId, path)`,
`projects.files(projectId, path)` and `projects.diff(projectId, path)`, where
every path is workspace-relative and the empty one is the workspace root. A diff
answer carries a `repositories` list — one `{ path, diff, changes }` entry per Git
repository the workspace tree holds, each discovering its own boundary — rather
than a single repository. Those
results are typed next to `WorkspaceApi` in `domain/workspace.ts`, and a rejected
call arrives as a thrown `Error`.

## Settings

The settings surface is application-global, and it lives in a `BrowserWindow` of
its own rather than in the workspace window. The status line's settings button
calls `window.doric.settings.open()`, which opens that window or focuses it when
it is already open, so the surface is reachable whether or not a Project or
Thread is selected and never borrows the workspace window's conversation,
sidebar or Thread. The window loads `settings.html`/`settings.tsx`, a second
webpack entry that mounts the settings view alone and shares the same sandboxed
preload boundary.

It shows only what the host actually stores: the providers Doric may call, the
provider and model execution runs on, its reasoning effort, the turn limit one
prompt may take, which stored credentials the Git identity and GitHub use, and
the credential store itself.

A provider row names a **credential**, not an environment variable, so no
provider key is part of the configuration and none travels through the renderer.

## Credentials

The Credentials section is the host's credential store. A credential is named,
has one of a closed set of kinds, and the kind decides which fields it carries:
`API_TOKEN` is authentication and holds one secret (a provider key or a GitHub
token), `USERNAME_PASSWORD` is authentication with a name, and `GIT` is identity
alone — the username and email the agent's git commands commit with — which is
why it holds no secret at all. `credentialFields` in `src/domain/config.ts`
mirrors the host's one rule, so the form asks for exactly what the host accepts
and a field the kind forbids is not rendered. A kind is fixed once the
credential exists, because changing it would change which fields the stored row
may carry.

The secret is the one value this surface never reads. The host answers whether
one is stored and never the value, so an edit starts with the field empty and an
empty field keeps what is stored — the same rule the API applies: absent or
`null` keeps, `''` clears, and a value sets. `use-credentials.ts` owns the list
and every write, and the section reports a refusal beside the row that caused it
rather than losing what was typed.

## Versioning

The Versioning section chooses which stored credentials the agent uses inside a
Project's sandbox, from a combobox per integration. The **Git identity** picks a
`GIT` credential and is who commits; the **GitHub token** picks an `API_TOKEN`
credential and is what authenticates a push and the sandbox's GitHub CLI. Each
combobox offers only the kind its integration needs, so the two halves cannot be
crossed, and `None` is a real choice that clears the reference.

The choices are explicit rather than inferred. The host falls back to the only
credential of a kind when a choice is unset, but a selection recorded here is
what the configuration carries, which is how an ambiguous store is resolved and
how a Project is told which of several credentials to use.

The host owns the configuration as a singleton with a revision, and the window
round-trips it: `window.doric.config.get()` seeds the draft when the window opens
and `window.doric.config.update(configurationInput(draft))` sends it back,
returning the revision the host stored. There is no Save button — a change saves
itself once typing settles (500 ms in `use-config.ts`), on a field blur, and as
the window closes, and the window's footer reports the revision, the update time
and the save state instead of offering one. A draft the host would refuse is never sent and is
explained above the section, because the same rules live in `src/domain/config.ts`
and the host re-validates them; a failed save keeps the draft and shows the host's
message. Changing the execution model reaches new Projects only: a Project
keeps the configuration it was created with, and one already running keeps running
as it was. The credential choices are the one exception: they follow the current
configuration, so the host applies a rotated secret to a Project that is already
running, on that Project's next prompt.

The providers section is a data table on TanStack Table v9
(`@tanstack/react-table`, declared by `app/doric-renderer/package.json`): its
columns sort, a field narrows the list by provider id, a footer pages it and
chooses the rows per page, a menu shows and hides columns, and a checkbox column
selects rows. Every cell is still an input, so the table is a form and not a
listing — sorting, filtering, visibility, paging and the selection are this
component's own view state, and an edit sends the whole configuration through
`useConfig`, which debounces and saves it, exactly as before.

One rule keeps that safe. A row is addressed by its position in the provider
list, the only identity it has before its id is typed, and the table's order is
not the list's order, so the position a row is drawn at is not the position it
edits. `providerRows` in `src/domain/config.ts` carries each provider's position
on the row it draws, and every edit and removal reads it from there, so sorting,
filtering and paging draw rows in any order without ever addressing the wrong
provider. `tests/config.test.ts` covers it.

The secret is never part of the configuration. The host stores it, answers
whether one exists, and never sends the value back; the sandbox receives the
chosen Git identity and GitHub token separately, and the host writes the token
into the sandbox's `gh` hosts file so the GitHub CLI is authenticated there too.

The host owns the configuration as a singleton with a revision, and the window
round-trips it: `window.doric.config.get()` seeds the draft when the window opens
and `window.doric.config.update(configurationInput(draft))` sends it back,
returning the revision the host stored. There is no Save button — a change saves
itself once typing settles (500 ms in `use-config.ts`), on a field blur, and as
the window closes, and the window's footer reports the revision, the update time
and the save state instead of offering one. A draft the host would refuse is never sent and is
explained above the section, because the same rules live in `src/domain/config.ts`
and the host re-validates them; a failed save keeps the draft and shows the host's
message. Changing the execution model reaches new Projects only: a Project
keeps the configuration it was created with, and one already running keeps running
as it was. The GitHub block is the one exception: its identity and token follow
the current configuration, so the host applies a rotated token to a Project that
is already running, on that Project's next prompt.

## Development

Use the combined Electron workflow from the repository root:

```console
npm run doric:dev
```

Run renderer checks directly with:

```console
npx nx run doric-renderer:typecheck
npx nx run doric-renderer:lint
npx nx run doric-renderer:test
npx nx build doric-renderer
```

Add or inspect components through the project-aware shadcn CLI:

```console
npx shadcn@latest info --json -c app/doric-renderer
npx shadcn@latest add COMPONENT -c app/doric-renderer
```
