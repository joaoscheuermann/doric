# threads

Apply these rules to `bundles/features/threads/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to delegation: the tools and skills by which an agent creates,
observes, steers and closes the direct children of the calling prompt's Thread,
and the drawing of delegated inputs and `thread-spawn` calls in the
conversation. Add to it no way to reach a Thread that is not a direct child of
the calling prompt, no store of its own, and no rule of how the runtime creates
a child or delivers its result: those belong to the bundle that provides
`runtime.threads/v1`.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it,
  and [Delegation](../../../docs/features/delegation.md) for the flow across
  bundles.
- Reach every child only through `threadsOf(services, call)` in
  `src/host/threads.ts`, so that each runtime call is bound to the scope of
  the tool call it serves; pass `call` on to every runtime method.
- Put a new tool in `src/host/tools/<tool-name>.ts`, exporting `tool` built
  with `defineTool` and a strict zod input, and register it in the
  `threadTools` list of `src/host/index.ts` with `alwaysAvailable: true` and an
  order that no other tool of this bundle uses. Never renumber an existing
  tool: each order is the tool's global model-visible position. Keep the
  expected tool names of the order test in `tests/threads.test.ts` in the
  order of `threadTools`.
- Return every tool output as a string: the JSON of the runtime's answer,
  except `thread-interrupt`, which answers the runtime's bare result. Never
  trim or rewrite a `prompt` before it reaches the runtime.
- Let a runtime or `default.agents/v1` error reach the caller unchanged; map an
  error only where `src/host/tools/thread-spawn.ts` already does, and add a
  case there only with its test in `tests/threads.test.ts`.
- Keep `default.agents/v1` under `optional` in [`manifest.json`](manifest.json):
  a spawn that names no agent must work without it.
- Put a new skill in `src/skills/<skill-name>/SKILL.md` with `name`,
  `description` and an `order` that no other skill of the bundle uses; set
  `alwaysAvailable: true` only on a skill the agent needs on every prompt.
- Put DOM-free client logic in `src/client/domain/`, so that
  `tsconfig.spec.json` compiles it for `tests/`; put a new element in its own
  file under `src/client/`, define it through `ui/v1` in `activate` of
  `src/client/index.ts`, and dispose it in the returned cleanup.
- Never import `chat/contracts`. Reach `chat.views/v1` only through the
  structural copy in `src/client/chat-contract.ts`, inside
  `services.whenAvailable(ChatViewsV1, …)`; add to that copy only the members
  you call, and change it when chat changes them: nothing checks the copy
  against chat's definition.
- Give each `chat.views/v1` registration that may be refused its own
  `whenAvailable` callback or its own `try`, so that a refused registration
  leaves the others in place.
- Read a Thread's name or Project only through `useDelegatedSource` in
  `src/client/source.ts`, and open a conversation only through its `open`:
  `runtime.records/v1` is optional, and a Thread it does not hold is drawn by
  its short id.
- Keep every block drawn through `desktop/ui/collapsible-block` and every text
  drawn through chat's `<chat-readonly-markdown>`, created with `ui/v1`.
- Keep the projector of `src/client/old-asks.ts` claiming
  `threads.asked/v1` and `threads.answered/v1` and drawing nothing: Thread
  logs hold those rows.
- When you add a client source folder of another bundle to the `@source`
  lines of `src/client/styles.css`, add it as a path relative to that file;
  never remove the `desktop/workspace/src/client` line, which
  `tests/workspace-sheet.test.ts` checks.
- When you change `version` in `manifest.json`, change the version that
  `tests/threads.test.ts` and `tests/workspace-sheet.test.ts` assert in the
  same change.
- Add the tests of a change in the same change: a host tool's in
  `tests/threads.test.ts`, through `activatedTools` of `tests/support/services.ts`;
  a domain helper's in `tests/<helper>.test.ts`; an element's in
  `tests/client/<element>.test.ts`, mounted in `happy-dom` through
  `tests/client/support/`.
- Update in the same change each feature doc the change touches:
  [Delegation](../../../docs/features/delegation.md) for the tools, skills and
  drawings; [Per-thread model](../../../docs/features/per-thread-model.md) for
  the model and effort of a spawn;
  [Coding workflow](../../../docs/features/coding-workflow.md) for how a spawn
  takes an agent's model and effort; [Skills](../../../docs/features/skills.md)
  for which skills are always available; and
  [Error messages](../../../docs/features/error-messages.md) for the failure
  notice of a spawn.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "threads"`.

## Verify

- `npx nx run bundle-threads:typecheck`: run it after any change under `src/`,
  `stories/` or `.storybook/`.
- `npx nx run bundle-threads:test`: run it after any change under `src/`,
  `tests/` or to `manifest.json`; it builds the bundle first.
- `npx nx run bundle-threads:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file, a `SKILL.md` or
  `src/client/styles.css`; it validates the manifest and the skills.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
