# Doric renderer

`doric-renderer` is the React, Tailwind CSS, Radix, and shadcn/ui surface loaded
by `doric-app`. Its compact sidebar creates, selects, renames, and deletes named
Projects and recursive Threads. The selected Thread displays its durable event
history and accepts serial prompts through a Lexical Markdown editor. The document
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
- Lexical holds each prose node as a Markdown document, and the document's own
  transformers are the interchange: an edited prompt is exported back to Markdown
  through them, so uncommon source may normalize on the way out.
- The conversation is a document of prose nodes — each human prompt, each agent
  answer segment, and the draft — while thinking, tool and delegated rows stay
  machine content outside the caret path. A saved prompt is editable in place on
  the same editor (`document.tsx`, `mode: 'write'`). While its
  text differs from the projection the node is dirty and every node below it dims
  until the text matches again (`editing.ts`, `dirtyIndex`). The draft submits
  through `threads.prompt`; an edited past prompt submits its text through
  `threads.rewind`, and either send discards the other pending edits and
  comments. An agent answer is caret navigable and selectable but never mutates
  (`mode: 'read'`): the surface stays editable so the caret works, and refuses
  every command that would rewrite the document, so typing creates or extends a
  comment anchored at the caret or over the selected excerpt, marked inline
  through the CSS Custom Highlight API (the rule lives in `index.html` because
  Tailwind's optimizer mis-parses the Custom Highlight pseudo-element) and listed
  below the node, removable. Every mounted answer publishes its ranges into
  `comment-highlight.ts`, which merges them under the one name the shell styles,
  so one node's marker never replaces another's. Sending
  composes the pending comments into a `## Comments` Markdown section appended to
  the prompt, so durable history records what was actually asked.
  `turn-node.tsx` keeps one renderer for every state, so opening a node never
  changes how its text looks.
- Arrow keys carry the caret between prose nodes at a node's edge, horizontally
  and vertically: the neighbour receives the caret at its start or end and the
  keyboard focus moves with it, so the next key belongs to the node the caret is
  in (`editing.ts`, `caretTarget`; `caret.ts` decides whether the caret still
  sits on the first or last rendered line, measuring the caret's own block when
  the caret reports no rect — an empty line). Machine rows are not prose nodes,
  so the caret steps over thinking, tool and delegated rows.
- The answer surface renders safe Markdown (no raw HTML, images, or tables) and
  reveals a streaming answer through the grapheme-safe typewriter in `reveal.ts`.
- Local storage contains only the versioned open-tab order and selection.
  Startup validates every saved ID with `threads.get` and drops Threads the
  backend reports as absent. A failed lookup aborts restoration and leaves the
  saved tabs untouched for the next launch.
- The composer follows the durable lifecycle. A Thread that is stopping,
  cancelled, or failed replaces the editor with an explanation, and a prompt
  that never produced a terminal event is shown as unanswered. A failed Project
  blocks every Thread beneath it, because the Project owns the sandbox lease.
- Running prose — a human prompt, an agent answer, the draft — is set in Noto
  Serif, vendored from Google Fonts under the SIL Open Font License (`src/assets/fonts`,
  license beside the files) because the packaged app's CSP allows fonts from
  `self` only. Thinking, tool and delegated rows stay sans and monospace, so the
  secondary machine-facing content never inherits the serif face.
- The conversation is a centered reading column (`MessageColumn`, `max-w-3xl`)
  inside full-width rows. A human prompt and the prompt input wear a band that
  reaches the panel edges; agent turns and delegated inputs stay bare, so the
  band is what marks the user's own text. The gutter slot is reserved in every
  row so all text shares one column: the agent shows a bare icon there, the human
  shows nothing, and the input shows a terminal prompt marker (`❯`, monospace),
  which also keeps a draft visually distinct from saved history. The input's
  placeholder is overlaid on the editor's first line (`document.tsx`), because
  Lexical renders it as a sibling after the surface and a block element would
  otherwise take a line of its own.
- A turn whose input was written by another Thread (a child's `result` or a
  parent's instruction) carries it as a delegated value rather than a user
  prompt: `Result from thread <name> · <status>` collapsed to a label, expanding
  to the sender's words on the shared payload surface (`payload.tsx`, the same
  monospace box as tool input and output) rather than as Markdown. The name comes
  from the cached tree the live Project
  subscription maintains, and a Thread it no longer knows falls back to its short
  id. `delegated.ts` strips the host's model-facing envelope before display and
  only when its header is present, so unknown text is shown verbatim.
- A turn is projected as ordered segments, not one string: a `thinking` run, a
  text run, and one segment per tool call, so `text → tool → text` keeps its
  chronology. Reasoning and tool rows are secondary content at the conversation's
  own type size — a `Thinking` row and a `Call <tool>` row toggle their payload
  from a chevron beside the label (`Call` in medium weight, the tool name in
  monospace), and only the active call carries a pulsing dot. Arguments appear
  only in the expanded `Input`; an expanded call shows `Input` and `Output`
  blocks on their own surface, rendered as plain monospace text rather than
  Markdown, so a table in tool output cannot lose content; a long result is
  clamped behind `Show all`. A call still open when the
  turn ends reports `no result recorded`.
- `projects.watch(projectId, listener)` mirrors the selected Project's tree, so a
  Thread created by an agent appears in the sidebar without a reload. Header tabs
  stay user-driven: a live-created Thread is inserted after its siblings and is
  never opened as a tab.
- The Project's sandbox is a right-hand panel (`ProjectFilesSidebar`) with a Files
  tree and a Changes view. It belongs to the Project rather than to the selected
  Thread, it only reads, and it holds every state a read can answer with —
  `pending` with the host's retry hint, `expired`, `unavailable`, `missing`, a
  refused path — as data, so an unusable sandbox is explained instead of failing.
  The panel's tabs sit in its header in place of a title, its toggle stays at the
  window's right corner whether the panel is expanded or collapsed (collapsed the
  panel is not mounted at all, and the main header carries the control that
  reopens it), and an open file puts a back control and the file's name at the
  header's left, with the footer carrying the directory it sits in — a chain too
  deep for that row collapses its middle behind one trigger (`collapsedPath`) —
  and the one action the surface has. The file itself is named once, above, so
  the footer's chain stops at its directory.
  `use-project-files.ts` owns the listings, the expansion, the open file and the
  diff, and reads a directory only when it opens and the diff only when the
  changes view is shown. There is no watcher: the panel re-reads on its own
  refresh, and on `useThreadChat`'s `writes` growing, which counts the finished
  `write`, `edit` and `terminal` calls in the Thread's log (`projector.ts`).
  `domain/files.ts` holds the path rules, the diff classification and the
  sentences the states show, and is covered by `tests/files.test.ts`.
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

State that the live subscription and tab persistence own is isolated in
`use-project-events.ts` and `use-persisted-tabs.ts`, which keeps `app.tsx` on the
composition and layout side.

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
`projects.files(projectId, path)`, `projects.file(projectId, path)` and
`projects.diff(projectId, path)`, where every path is workspace-relative and the
empty one is the workspace root. Those results are typed next to `WorkspaceApi`
in `domain/workspace.ts`, and a rejected call arrives as a thrown `Error`.

## Settings

The settings modal is application-global, opened from the status line beside the
connection label, so it is reachable whether or not a Project or Thread is
selected. It shows only what the host actually stores: the providers Doric may
call, the provider and model execution runs on, its reasoning effort, the turn
limit one prompt may take, and the Credentials section — today one `GitHub`
block, holding the username, email and token the agent's git commands use inside
a Project's sandbox. A provider row names the environment variable holding its
API key rather than the key, so no provider credential travels through the
renderer.

The GitHub token is the one secret this surface handles, and it is write-only.
The host answers whether it holds one and never the token, so the password field
always starts empty, an empty field keeps whatever is stored, and the section
says as much: the host stores the token, never sends it back, and the agent's
git commands use it inside the sandbox. The host writes the same token into the
sandbox's `gh` hosts file, so the GitHub CLI is authenticated there too.
`tokenFieldText` and
`storedTokenNotice` in `src/domain/config.ts` hold that wording and the rule it
states, and `configurationInput` is what turns a draft into the body a save
sends, where an empty token field becomes `null` — which keeps the stored token
— rather than `''`, which clears it. The block itself follows the same three
spellings as the token: absent leaves the stored credentials alone, `null`
removes them, and a block sets them — so an emptied section sends `github: null`
rather than dropping the key, because a secret must never be deletable by a
caller that simply omitted it. Everything else on the surface stays
credential-free.

The host owns the configuration as a singleton with a revision, and the modal
round-trips it: `window.doric.config.get()` seeds the draft when the dialog opens
and `window.doric.config.update(configurationInput(draft))` sends it back,
returning the revision the host stored. There is no Save button — a change saves
itself once typing settles (500 ms in `use-config.ts`), on a field blur, and on
close, and the dialog's footer reports the revision, the update time and the save
state instead of offering one. A draft the host would refuse is never sent and is
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
