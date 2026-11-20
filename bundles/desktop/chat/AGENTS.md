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

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Put client code in the folder of its layer under `src/client/`: `views/` for
  the content of `<chat-view>` and `<chat-composer>`, `elements/` for the
  custom elements `ui/v1` defines, `components/molecules/` and
  `components/organisms/` for React components, `hooks/` for every `use*`
  hook, `stores/` for Zustand stores, `queries/` for TanStack Query keys and its
  client, `domain/` for the product's pure rules, `utility/` for helpers stated
  only in terms of their arguments, `api/` for adapters over the host's and
  other bundles' contracts, and `services/` for the chat's own contract
  providers and the watchers bound to activation.
- Put a rule that can be stated in terms of its arguments in `domain/` or
  `utility/`. Test the desktop part through `tests/support/desktop.ts`, and
  window behavior through the window of `tests/client/support/window.ts`.
- Give one file one responsibility, and do not change a neighbour's contract in
  the same change that splits a file.
- Treat the Thread's log on the host as the only source of its history: the
  Thread store in `src/client/stores/thread-chats.ts` holds a view of it, and
  `history.snapshots/v1` only seeds that view. Never draw a turn the log does
  not hold, except the pending turns of `src/client/domain/pending-turns.ts`.
- Keep the built-in projector in `src/client/domain/projector.ts` pure, and
  keep every `chat.views/v1` projector run from its initial state over the
  whole event list.
- Decide which drawing a tool call or an input gets only in
  `src/client/domain/tool-drawing.ts` and `src/client/domain/drawn-turns.ts`,
  and draw an unregistered call only with
  `src/client/components/molecules/tool-item.tsx`, the generic row. Never add a
  built-in drawing or placement for a tool name: a tool's drawing comes from its
  `registerToolRenderer` registration alone.
- Fire `onSandboxActivityHook` only for a Thread's lifecycle, as
  `src/client/domain/project-refresh.ts` decides it; never add a tool call as a
  cause.
- Tell a prompt's source only by its source kind (`fromTerminal` in
  `src/client/domain/projector-input.ts` for a terminal), never by parsing its
  text.
- Take the collapsible block and its generic open/closed rule from
  `desktop/ui/collapsible-block`; keep in `src/client/domain/collapsible.ts`
  only the rules that name the chat's own blocks.
- Reach `workspace.hooks/v1` and `workspace.selection/v1` only through the
  structural copies in `src/client/api/workspace-hooks.ts` and
  `src/client/api/workspace-selection.ts`, and `settings.models/v1` and
  `history.snapshots/v1` only through a `ref` of their id with `import type`
  from their contracts: never import a value of `workspace/contracts`,
  `settings/contracts` or `history/contracts`, and keep those four ids under
  `optional` in [`manifest.json`](manifest.json), so that a composition without
  those bundles still loads the chat.
- Keep `chat.composer/v1` both under `provides` and under `requires` of
  [`manifest.json`](manifest.json): the client part needs the provider of the
  desktop part.
- When the owner of a contract the chat copies structurally changes its shape,
  change the copy in `src/client/api/` to match: nothing checks the copy.
- Keep `src/contracts/` free of React: `tests/contracts-imports.test.ts` fails
  on it.
- Keep `chat.lexical/v1` closed once the window's first conversation editor
  exists: never reopen it or rebuild an editor with nodes registered later.
- Send every prompt through the Thread store's `prompt` or `steer` with the
  text `promptEnvelope` builds in `src/client/domain/prompt-envelope.ts`, and
  read every stored prompt back through `parsePromptEnvelope` or
  `promptMessage`; never send or show a prompt by another path.
- Flush the composer's stack only after the host has accepted the prompt, and
  put back on the stack, under its id, every item whose comment write fails.
- Keep the composer's state in `src/desktop/composer-state.ts`, free of the
  bridge and of every contract call, and keep `registerFlush` unexposed to
  windows. Register the flush of the `message` kind only from `src/desktop/`; a
  new comment kind of the chat registers its flush there too.
- Add the title of every error code the chat shows to
  `src/client/domain/error-catalog.ts`, and pass that catalog to every
  `ErrorNotice` and `toastError` the chat draws.
- Add no second theme: the shell's sheet already emits the utilities this
  bundle uses. Keep `isolation: isolate` on `.conversation-scroll`, add no `z-index` to a
  footer band, and read a floating footer's height only from
  `--shell-conversation-footer-height`.
- To add a feature to the conversation itself, put its rule in `domain/` and
  its drawing in a Lexical node or plugin under
  `src/client/components/organisms/conversation/`; to add one to the footer,
  extend `src/client/views/chat-composer.tsx` or add an item to
  `shell.conversation.footer` from `src/client/index.ts`; to add one to the
  shared draft, extend `ChatComposer` in `src/contracts/index.ts`, add the
  method to `chatComposerMethods` with `expose: 'desktop'` unless it carries a
  function, implement it in `src/desktop/composer-state.ts` and
  `src/desktop/composer-service.ts`, and add its window side in
  `src/client/api/composer.ts`.
- To let other bundles extend a new part of the conversation, extend
  `chat.views/v1`, `chat.hooks/v2` or `chat.send/v1` with a registration or a
  hook that names no bundle; never add a branch for a particular bundle, tool,
  source or event type of another bundle.
- Update, in the same change, each feature doc the change belongs to among
  those [`README.md`](README.md) links.
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
