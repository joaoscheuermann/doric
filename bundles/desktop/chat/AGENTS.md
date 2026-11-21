# chat

Apply these rules to `bundles/desktop/chat/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to the conversation of one Thread: its transcript, the
composer with its shared draft and comment stack, the queue and the trail, the
footer composer and execution picker, and the Thread tabs it opens. Do not draw
another bundle's tool, input source, fence, event or block here: each drawing
belongs to the bundle that owns the tool, source or event, which registers it
through `chat.views/v1`. Do not add a rule for choosing a model or an effort:
those rules belong to the provider of `settings.models/v1`. Do not refresh
another bundle's data after its tool: the owner of the tool observes
`chat.hooks/v2.onThreadUpdateHook` and asks for its own refresh.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it,
  and the feature doc of the part you change among those it links, such as
  [Conversation](../../../docs/features/conversation.md) for the transcript and
  [Comments](../../../docs/features/comments.md) for the stack; update, in the
  same change, each feature doc the README links that the change belongs to.
- Put client code in the folder of its layer under `src/client/`: `views/` for
  the content of `<chat-view>` and `<chat-composer>`, `elements/` for the
  custom elements `ui/v1` defines, `components/molecules/` and
  `components/organisms/` for React components, `hooks/` for every `use*`
  hook except one that reads a store its own module defines, which stays in
  that module (as `useExecutionSources` stays in
  [`stores/execution-sources.ts`](src/client/stores/execution-sources.ts) and
  `useSharedNodeSelection` in
  [`components/molecules/widget-focus.tsx`](src/client/components/molecules/widget-focus.tsx)),
  `stores/` for Zustand stores, `queries/` for TanStack Query keys and its
  client, `domain/` for the product's pure rules, `utility/` for helpers stated
  only in terms of their arguments, `api/` for adapters over the chat's own
  `chat.composer/v1` and over the host's and other bundles' contracts, and
  `services/` for the chat's own contract providers and the watchers bound to
  activation.
- Put a rule that can be stated in terms of its arguments in `domain/` or
  `utility/`. Test the desktop part through
  [`tests/support/desktop.ts`](tests/support/desktop.ts), and window behavior
  through the window of
  [`tests/client/support/window.ts`](tests/client/support/window.ts).
- Give one file one responsibility, and do not change a neighbour's contract in
  the same change that splits a file.
- Keep `src/contracts/` free of React and of every `desktop/ui` import but
  `desktop/ui/identity`:
  [`tests/contracts-imports.test.ts`](tests/contracts-imports.test.ts) fails
  on either.
- Keep `chat.composer/v1` both under `provides` and under `requires` of
  [`manifest.json`](manifest.json): the client part needs the provider of the
  desktop part. A member added to `chat.composer/v1` therefore raises its
  minor in both entries.
- Reach `workspace.hooks/v1` and `workspace.selection/v1` only through the
  structural copies in
  [`src/client/api/workspace-hooks.ts`](src/client/api/workspace-hooks.ts) and
  [`src/client/api/workspace-selection.ts`](src/client/api/workspace-selection.ts),
  and `settings.models/v1` and `history.snapshots/v1` only through a `ref` of
  their id with `import type` from their contracts: never import a value of
  `workspace/contracts`, `settings/contracts` or `history/contracts`, and keep
  those four ids under `optional` in [`manifest.json`](manifest.json), so that
  a composition without those bundles still loads the chat.
- When the owner of a contract the chat copies structurally changes its shape,
  change the copy in `src/client/api/` to match: nothing checks the copy.
- When you add or raise a `requires` entry, add that contract at a matching
  version to the `shell` bundle of
  [`tests/support/desktop.ts`](tests/support/desktop.ts) and to the candidate
  that provides it in
  [`tests/client/support/window.ts`](tests/client/support/window.ts)
  (`hostCandidateFor`, `recordsCandidate`, or a candidate of its own built as
  `recordsCandidate` is): both list each contract at a
  fixed version, and the chat fails to resolve in its own tests otherwise.
- Treat the Thread's log on the host as the only source of its history: the
  Thread store in
  [`src/client/stores/thread-chats.ts`](src/client/stores/thread-chats.ts)
  holds a view of it, and `history.snapshots/v1` only seeds that view. Never
  draw a turn the log does not hold, except the pending turns of
  [`src/client/domain/pending-turns.ts`](src/client/domain/pending-turns.ts).
- Keep the built-in projector in
  [`src/client/domain/projector.ts`](src/client/domain/projector.ts) pure, and
  keep every `chat.views/v1` projector run from its initial state over the
  whole event list.
- Decide which drawing a tool call or an input gets only in
  [`src/client/domain/tool-drawing.ts`](src/client/domain/tool-drawing.ts) and
  [`src/client/domain/drawn-turns.ts`](src/client/domain/drawn-turns.ts), and
  draw an unregistered call only with
  [`src/client/components/molecules/tool-item.tsx`](src/client/components/molecules/tool-item.tsx),
  the generic row. Never add a built-in drawing or placement for a tool name:
  a tool's drawing comes from its `registerToolRenderer` registration alone.
- Fire `onSandboxActivityHook` only for a Thread's lifecycle, as
  [`src/client/domain/project-refresh.ts`](src/client/domain/project-refresh.ts)
  decides it; never add a tool call as a cause.
- Tell a prompt's source only by its source kind (`fromTerminal` in
  [`src/client/domain/projector-input.ts`](src/client/domain/projector-input.ts)
  for a terminal), never by parsing its text.
- Take the collapsible block and its generic open/closed rule from
  `desktop/ui/collapsible-block`; keep in
  [`src/client/domain/collapsible.ts`](src/client/domain/collapsible.ts) only
  the rules that name the chat's own blocks.
- Keep `chat.lexical/v1` closed once the window's first conversation editor
  exists: never reopen it or rebuild an editor with nodes registered later.
- To add a block to the conversation, in one change: put its rule in
  `domain/`; add its block type to
  [`src/client/domain/conversation-nodes.ts`](src/client/domain/conversation-nodes.ts),
  and to its undeletable or read-only set when the block needs that rule;
  write its Lexical node under `src/client/components/organisms/conversation/nodes/`;
  add the node to the editor's `nodes` list in
  [`src/client/components/organisms/conversation/index.tsx`](src/client/components/organisms/conversation/index.tsx);
  and, for a turn, insert it from
  [`plugins/insert-thread-turn-nodes.tsx`](src/client/components/organisms/conversation/plugins/insert-thread-turn-nodes.tsx).
  Put a behavior of the editor that is not a block in a plugin under
  `src/client/components/organisms/conversation/plugins/`. Test the block's
  rules in [`tests/conversation-nodes.test.ts`](tests/conversation-nodes.test.ts)
  and its drawing in
  [`tests/client/conversation-nodes.test.ts`](tests/client/conversation-nodes.test.ts).
- To add to the footer, extend
  [`src/client/views/chat-composer.tsx`](src/client/views/chat-composer.tsx) or
  add an item to `shell.conversation.footer` from
  [`src/client/index.ts`](src/client/index.ts).
- Send a draft, the reader's words with the stack, only as the text
  `promptEnvelope` builds in
  [`src/client/domain/prompt-envelope.ts`](src/client/domain/prompt-envelope.ts),
  through the Thread store's `prompt` or `steer`: the composer sends it from
  [`plugins/send-prompt.tsx`](src/client/components/organisms/conversation/plugins/send-prompt.tsx)
  by `routeSend` over the ports of
  [`src/client/hooks/use-thread-chat.ts`](src/client/hooks/use-thread-chat.ts),
  and `sendStack` of [`src/client/services/send.ts`](src/client/services/send.ts)
  sends it for `chat.send/v1` through the store's `prompt`.
- Save the edit of a queued prompt only as the text `withPromptMessage` builds,
  through `editQueued`, as
  [`plugins/edit-queue-prompt.tsx`](src/client/components/organisms/conversation/plugins/edit-queue-prompt.tsx)
  does.
- Send an action of a UI the agent drew only through `sendUiAction` of
  [`src/client/services/send.ts`](src/client/services/send.ts), which builds
  `uiActionEnvelope` and sends it by `routeSend`
  ([`src/client/domain/send-route.ts`](src/client/domain/send-route.ts))
  straight to the host's Thread API, never through the composer or the store.
- Replace a past prompt only through the store's `rewind` in
  [`src/client/stores/thread-chats.ts`](src/client/stores/thread-chats.ts),
  which sends the text it is given unchanged through `threads.rewind` and
  draws no pending turn; give it the text `promptEnvelope` builds.
- Read every stored prompt back through `parsePromptEnvelope` or
  `promptMessage`. Never send or show a prompt by another path.
- Keep the composer's state in
  [`src/desktop/composer-state.ts`](src/desktop/composer-state.ts), free of the
  bridge and of every contract call. It is keyed by the call scope's
  `projectId` and the Thread the input names: give every method of
  `chat.composer/v1` but `registerFlush` the `threadId` in its input, and pass
  `projectOf(call)` to the state from
  [`src/desktop/composer-service.ts`](src/desktop/composer-service.ts).
- To add a method to the shared draft: extend `ChatComposer` in
  [`src/contracts/index.ts`](src/contracts/index.ts), add its spec to
  `chatComposerMethods` there, and read its `expose`, `input` and `output` from
  that spec in [`src/desktop/composer-service.ts`](src/desktop/composer-service.ts);
  implement it in [`src/desktop/composer-state.ts`](src/desktop/composer-state.ts);
  and call it from a window only through `composerFor` in
  [`src/client/api/composer.ts`](src/client/api/composer.ts), with the
  Thread's `projectId` and `threadId` as its scope, as `threadScope` builds it:
  that module is the only client code that calls the contract. Test the
  desktop side in [`tests/composer-service.test.ts`](tests/composer-service.test.ts)
  and the window side in [`tests/client/composer.test.ts`](tests/client/composer.test.ts).
- Keep `registerFlush` unexposed to windows. Register the flush of a comment
  kind the chat owns with `state.registerFlush(kind, flush)` in `activate` of
  [`src/desktop/index.ts`](src/desktop/index.ts), with the flush in a module
  beside [`src/desktop/message-flush.ts`](src/desktop/message-flush.ts), and
  dispose the registration in the cleanup `activate` returns.
- Flush the composer's stack only after the host has accepted the prompt, and
  put back on the stack, under its id, every item whose comment write fails.
- Add the title of every error code the chat shows to
  [`src/client/domain/error-catalog.ts`](src/client/domain/error-catalog.ts),
  and pass that catalog to every `ErrorNotice` and `toastError` the chat draws.
- Keep `@layer theme, base, components, utilities;` first in
  [`src/client/styles.css`](src/client/styles.css), and keep its `@source` of
  `packages/desktop/src`. Keep `isolation: isolate` on `.conversation-scroll`,
  add no `z-index` to a footer band, and read a floating footer's height only
  from `--shell-conversation-footer-height`.
- To let other bundles extend a new part of the conversation, extend
  `chat.views/v1`, `chat.lexical/v1`, `chat.hooks/v2` or `chat.send/v1`, or
  let them add a comment kind through `registerFlush` of `chat.composer/v1`,
  with a registration or a hook that names no bundle; never add a branch for a
  particular bundle, tool, source or event type of another bundle. Test it
  with the `probe` option of `openChatWindow` in
  [`tests/client/support/window.ts`](tests/client/support/window.ts).
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "chat"`.

## Verify

- `npx nx run bundle-chat:typecheck`: run it after any change under `src/`,
  `stories/` or `.storybook/`.
- `npx nx run bundle-chat:test`: run it after any change under `src/` or
  `tests/`; run the tests only through this target, which builds the bundle
  first, because the window and desktop tests load it from `dist/`.
- `npx nx run bundle-chat:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None.
