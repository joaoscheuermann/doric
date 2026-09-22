# Doric renderer

`doric-renderer` is the React, Tailwind CSS, Radix, and shadcn/ui surface loaded
by `doric-app`. Its compact sidebar creates, selects, renames, and deletes named
Projects and recursive Threads. The selected Thread displays its durable event
history and accepts serial prompts through a Slate Markdown editor. The document
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
- Slate keeps Markdown source as one block per source line. Decorations provide
  same-surface formatting without an AST round trip, so uncommon or incomplete
  source remains byte-for-byte stable when submitted.
- Streamdown renders complete and partial agent Markdown. Raw HTML, images, and
  tables are excluded in this first version.
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
  which also keeps a draft visually distinct from saved history.
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

State that the live subscription and tab persistence own is isolated in
`use-project-events.ts` and `use-persisted-tabs.ts`, which keeps `app.tsx` on the
composition and layout side.

The preload conversation contract also exposes
`threads.prompt(id, markdown): Promise<{ promptId: string }>` and
`threads.get(id): Promise<Thread | undefined>`, where `undefined` means the
Thread no longer exists. `ThreadUpdate` is a discriminated union with
`snapshot`, `event`, `updated`, `deleted`, and safe `error` variants, and
`ProjectUpdate` with `snapshot`, `thread-updated`, `thread-deleted`,
`project-updated`, `project-deleted`, and safe `error`. Both subscriptions share
the Electron process's single Engine.IO connection.

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
