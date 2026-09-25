# Doric renderer

`doric-renderer` is the React, Tailwind CSS, Radix, and shadcn/ui surface loaded
by `doric-app`. Its compact sidebar creates, selects, renames, and deletes named
Projects and recursive Threads. The selected Thread displays its durable event
history as a rendered conversation — prose, reasoning, and tool calls, with the
composer always the last turn — and sends serial prompts with `Cmd+Enter`. The document
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
- The surface above that projection is one Lexical document whose blocks are the
  turns, with the composer last. `domain/conversation.ts` derives the turns and
  their parts from the log (a part is one run of the answer, of the reasoning, or
  one tool call) and owns every rule the reading rests on: which turn is writable,
  how a state reads beside an avatar, and what shape the document must have.
  `use-conversation.ts` exposes the derived turns and the one action, and
  `use-conversation-document.ts` writes them into the editor in place — a turn and
  a part each keep their node, and only the run an answer is still appending to is
  rebuilt, which is what leaves the caret where the person put it.
- Markdown is the document's language in both directions. An answer's markdown is
  parsed into blocks as it streams, with its last half-written run healed by
  `remend`; the composer is written in the editor and exported back to markdown
  when it is sent. `components/molecules/markdown-blocks.ts` holds the node
  registry, the theme and both conversions, and `domain/markdown.ts` holds how a
  tool's payload becomes a code block it cannot escape from.
- A turn's chrome — the avatar, the label naming another Thread's words, the state
  dot, and each part's `Thinking`/`Call …` head — is deliberately not content: it
  is DOM the node owns outside the range Lexical manages (`getDOMSlot`), so it is
  in no node, no copy and no selection, and the caret has no position to stop in.
  `use-sealed-turns.ts` refuses every edit that would land in a turn nobody may
  write in, and the invariant in `use-conversation-document.ts` puts back anything
  that gets past it, because a turn on screen is a rendering of what the host
  stored. The composer is the one exception, and deliberately: its words are the
  person's own, not a rendering of anything, so there is no stored truth to put
  back — what guards them is the refusal alone, and a repair never writes there.
- Reasoning and tool calls are folds. A closed fold holds nothing: its content is
  simply not in the document, so `agentParts(turn, open)` decides it and the head
  reports a click as `TOGGLE_FOLD_COMMAND`, which `use-fold-command.ts` answers
  with the surface's state.
- A comment is made on a span of the answer being answered, and it lives in three
  places that agree: `CommentedTextNode` marks the words, `CommentFieldNode` puts
  the field that edits it below the block the span ends in, and `CommentCardNode`
  shows it back in the person's next turn. `domain/comments.ts` owns the one format
  that carries a comment to the host — a `# User comments` block above
  `# User request`, sent as the same prompt, and read back only when it is complete
  enough to be nobody else's text — and `markdown-blocks.ts` keeps those nodes
  through every write of the words beside them (`$setMarkdown`'s `keep`). What a
  comment stores is the quoted words and nothing else, so a phrase an answer says
  twice is marked where it says it first: the span is found again by its text, and
  a selection that is not the answer's own prose — its reasoning, a tool's payload,
  the person's own turn — offers nothing to comment on.
- An earlier prompt is rewritten where it stands. Enter in one of the person's own
  sealed turns opens it (`use-edit-keys.ts`), the turns after it render translucent
  because a resubmit discards them, Escape puts them back — including whatever
  comment the person was writing before the edit began, which the edit holds apart
  from its own (`ConversationState.editComments`) — and Cmd+Enter sends the
  rewritten prompt with `threads.rewind`, carrying the comments the prompt already
  held, because rewriting a request must not throw away what was said about the
  answer.
- `projects.watch(projectId, listener)` mirrors the selected Project's tree, so a
  Thread created by an agent appears in the sidebar without a reload.
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
