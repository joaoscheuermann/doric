# openui

Apply these rules to `bundles/features/openui/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to answering with UI in the conversation: drawing
`openui-lang` fences, the question form, the reader's actions back to the
agent, the diagrams of those fences, the delivery of program errors to the
agent, and the pure program modules every owner of program fences shares. Do
not add to it the drawing of another fence tag or of repository code, the
finding of fences in an answer or the routing of a message to a Thread: each
belongs to the bundle that owns that tag, the conversation or the Thread.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Keep `src/contracts/` free of React and of every `@openuidev/*` package, and
  take an OpenUI function as a parameter where a pure module needs one, as
  `createProgramFold(merge, isQuestion)` and
  `defineQuestionBuiltins(define, renderers)` do: another bundle's host and
  windows import these modules.
- Keep the identity, fold, reporter and `shownErrors` of `src/contracts/` the
  same for every tag in `PROGRAM_TAGS`: never branch on a tag there, because
  another owner of program fences calls them for its own tag.
- Keep `OPENUI_ERROR_CODES` equal to lang-core's `OpenUIErrorCode`; when an
  upgrade of `@openuidev/lang-core` changes the codes,
  [`tests/error-codes.test.ts`](tests/error-codes.test.ts) fails the test
  build until the list matches.
- Keep the input schemas of `openui.programs/v1` and `openui.questions/v1`
  strict, and clamp in the reporter every value the host schema would refuse
  (count, statement pattern, message length), so that a window's report is
  never refused.
- Take program errors in the host only from `reportErrors`: never parse a
  fence in `src/host/` to find errors, and never reject a report because its
  prompt is stale or its Thread unknown.
- Append `openui.answered/v1` only after sending the answers, never append a
  second row for an answered question, and read a question's state from the
  Thread's log on every call, never from a cache.
- Never import a module of the renderer chunk by value from
  `src/client/index.ts` or anything it reaches: name the chunk's exports only
  as types (`RendererChunk`) and load the chunk only through `chunkLoader` in
  [`src/client/folds.ts`](src/client/folds.ts). Share no relative module by
  value between the entry and the renderer chunk except
  `src/client/chat-contract.ts`
  ([`tests/client-split.test.ts`](tests/client-split.test.ts)).
- Import `@openuidev/*` only from modules the renderer chunk reaches, never
  from the client entry's graph
  ([`tests/client-chunk.test.ts`](tests/client-chunk.test.ts)).
- Import `elkjs` only in `src/client/chunks/layout.ts`, keep that file's
  license header, reach the layout chunk only through the layout loader of
  `src/client/chunks/renderer.ts`, and share with it only the types of
  `src/client/diagram/layout-types.ts`, imported with `import type`.
- Lay out a `SequenceDiagram` only with `src/client/diagram/sequence-layout.ts`:
  never call the layout loader for it.
- Put a file in `src/client/chunks/` only when it is to load as its own chunk:
  the build emits every `.ts` file there as `client/chunks/<name>.js`. Put a
  module the renderer chunk bundles elsewhere under `src/client/`.
- Import no CSS from `src/client/chunks/renderer.ts`: put the chunk's styles in
  `src/client/tokens.css` or in `src/client/chunks/renderer-styles.ts`, because
  the client tests load the renderer under Node.
- Set `--openui-*` variables only in `src/client/tokens.css`, inside
  `@layer openui-doric` and from Doric's tokens, and keep its
  `@layer openui, openui-doric;` statement before them.
- Never define a keyframe named `fadeIn` in any Doric stylesheet: react-ui's
  sheet defines `fadeIn` without its `openui` prefix, and layers do not scope
  keyframe names.
- Keep every `@source` line of `src/client/styles.css`; when you raise the
  manifest's `version`, change the version that
  [`tests/workspace-sheet.test.ts`](tests/workspace-sheet.test.ts) asserts in
  the same change.
- Reach `chat.views/v1`, `chat.send/v1` and `chat.hooks/v2` only through the
  structural copy in `src/client/chat-contract.ts`. When chat changes a shape
  or member the copy names (`ChatThreadEvent`, `ProjectorSpec`, `ChatFence`,
  `ChatFenceView`, `registerProjector`, `registerFenceRenderer`,
  `watchFences`, `ChatActionInput`, `ChatActionResult`, `sendAction`,
  `onThreadUpdateHook` and its input), change the copy to match: contracts are
  matched by id only, and nothing checks the copy against chat's definition.
- Keep `chat.hooks/v2` under `optional` in [`manifest.json`](manifest.json) and
  reach it only with `HooksV1.whenAvailable`, so that a composition without it
  still loads the bundle.
- Send a reader's click only through `chat.send/v1.sendAction`, and only from
  the latest closed revision in a main Thread, as `blockedReason` in
  `src/client/chunks/renderer.ts` decides.
- Never edit [`tests/fixtures/ask-markup.json`](tests/fixtures/ask-markup.json):
  it is the frozen markup the question form must keep rendering.
- Change a rule of the `openui` skill only in `doricRules` or `diagramRules` of
  [`tests/client/skill-text.test.ts`](tests/client/skill-text.test.ts), then
  regenerate the skill as [Generated files](#generated-files) says.
- Add a diagram type in these steps: define it and its parts with a
  `define*Builtins` function and a `*_LIMITS` constant in
  `src/client/diagram/definitions.ts`, and add it to `DiagramType` and
  `DIAGRAM_PARTS`; read its props in its own `src/client/diagram/*-model.ts`
  into a drawn model and findings, using the helpers of `read.ts` and
  `TEXT_LIMITS`; add its reading to `DIAGRAMS` in
  `src/client/diagram/check.ts`; draw it in its own
  `src/client/diagram/<type>.tsx` view through `DiagramFrame`, `useDrawn` and
  the outline, and pass that view to its `define*Builtins` call in
  `src/client/library.ts`, with `none` for its parts; add its components to
  the library's `add` list; add its `define*Builtins` call and components to
  `generate` in
  [`tests/client/skill-text.test.ts`](tests/client/skill-text.test.ts) and its
  use and limits to `diagramRules`; then regenerate the skill.
- Add a check of a program to `src/client/check.ts`: in `ownErrors` when the
  reader's card shows it, in `questionCheck` when only the agent gets it, with
  a code of `OPENUI_ERROR_CODES` and a message of at most 300 code units.
- Add a member to `openui.programs/v1` or `openui.questions/v1` in
  `src/contracts/programs.ts` or `src/contracts/questions.ts` with its schema
  in the method specs, and implement it in `src/host/validation.ts` or
  `src/host/questions.ts`.
- Give each method a window calls `expose: 'desktop'` in its method spec, list
  its contract under `desktopScope` of [`manifest.json`](manifest.json) with
  `["projectId", "threadId"]`, and read the Thread from the call scope,
  throwing `invalid_scope` when it lacks either key, as `scopeOf` in
  `src/host/validation.ts` does.
- Register a new event of this bundle with `events/v1` in
  `src/host/routed.ts`, and add its type to `eventTypes` of `answersProjector`
  in `src/client/answers-projector.ts`, so that chat draws no block for its
  rows.
- Add the tests of each change in the same change: a host or contract test in
  `tests/*.test.ts` over the fake `runtime.threads/v1` of
  [`tests/support/router.ts`](tests/support/router.ts); a client test in
  `tests/client/*.test.ts` that imports `tests/client/support/dom.ts` first,
  then draws a fence through `ConversationFence` with a fake `layout` and the
  recording services stub of
  [`tests/client/support/fence.ts`](tests/client/support/fence.ts), or
  activates the client entry over the stub of
  [`tests/client/support/client.ts`](tests/client/support/client.ts); and for
  a diagram reading, one case per rule with the exact finding texts in order.
- Update the feature doc the change belongs to in the same change:
  [generative UI](../../../docs/features/generative-ui.md) for fences, actions,
  questions, errors and the skill;
  [diagrams in OpenUI fences](../../../docs/features/openui-diagrams.md) for
  diagrams; and [papercraft](../../../docs/features/papercraft.md) for a change
  to the pure modules of `src/contracts/` or to `openui.programs/v1`.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "openui"`.

## Verify

- `npx nx run bundle-openui:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-openui:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the
  bundle first, because `tests/client-chunk.test.ts` reads the built chunks
  under `dist/`.
- `npx nx run bundle-openui:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file, `src/contracts/` or
  `src/client/chunks/`.

## Generated files

- `src/host/skills/openui.md`: do not edit it by hand; run
  `OPENUI_SKILL_UPDATE=1 npx nx run bundle-openui:test`.
