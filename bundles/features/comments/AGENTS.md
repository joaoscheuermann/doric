# comments

Apply these rules to `bundles/features/comments/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to storing, listing and resolving anchored comments as events
of the Thread log, and to the agent's `comment_reply` tool. Add to it no UI,
no draft, no prompt text and no meaning of a target `kind`: drafting a comment
and carrying it to the agent belong to the bundle that holds the composer, and
drawing a target, resolving its anchor and drawing its comments belong to the
bundle that owns the target's `kind`.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Keep the Thread log the only record of a comment: write only by appending
  `comments.added/v1` or `comments.resolved/v1` through `events/v1`, read only
  by folding those rows from `runtime.threads/v1`, and never hold comments in
  module state, a table, a file or a cache.
- Never append a comment row for a draft: `add` writes only when a caller
  calls it.
- Never branch on a target's `kind`, `id`, `revision` or anchor fields in
  `src/host/`: the registry stores them and forwards them as given.
- Add a new anchor field as an optional field of `anchorFields` and
  `CommentAnchor` in `src/contracts/index.ts`, so that every form may carry
  it, and check its shape, when it needs a check, in `addComment` of
  `src/host/comments.ts`, as the seat is checked there.
- Keep `add` idempotent on `commentId`: look the id up in the call's Thread
  before appending, and return the comment found without appending.
- Keep threads flat: normalize every `inReplyTo` to the root before writing,
  and refuse one the call's Thread does not hold.
- Keep writes and `resolve` on the call's own Thread, and refuse with
  `invalid_scope` a write whose scope lacks `projectId`, `threadId` or
  `promptId`.
- Keep the fold in `fold` of `src/host/comments.ts` tolerant: skip a row that
  breaks its event schema, keep the first `comments.added/v1` row of an id,
  and ignore a `comments.resolved/v1` row of a comment the Thread does not
  hold. Fold a new event type there too.
- Never append from a tool directly: write and read through `addComment`,
  `resolveComment` and `findComment` of `src/host/comments.ts`, so that every
  write keeps the checks above.
- Never rename `comment_reply`, change `AGENT_AUTHOR` (`'agent'`) in
  `src/host/tools/comment-reply.ts`, or change a field of the
  `comments.added/v1` or `comments.resolved/v1` payload, without first
  searching `bundles/` for the string and changing every copy in the same
  change. Other bundles match the tool, the agent's replies and the event rows
  by these literal strings and read the payloads by hand, and nothing checks
  the copies against this bundle (for example
  [`comment-threads.ts`](../../desktop/chat/src/client/domain/comment-threads.ts),
  [`preview-state.ts`](../papercraft/src/client/domain/preview-state.ts) and
  [`papercraft/src/host/skill.ts`](../papercraft/src/host/skill.ts)).
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "comments"`.
- Put a new method of `comments/v1` in the `Comments` interface and in
  `commentsMethods` of `src/contracts/index.ts`, and implement it in
  `createCommentsHost` of `src/host/service.ts`; expose it with `expose:
'desktop'` only when a window calls it, and add each scope key a window
  sends to `desktopScope` of [`manifest.json`](manifest.json).
- Register each new event in `registerCommentEvents` of `src/host/routed.ts`
  next to the
  two existing events.
- Put a new tool in its own file under `src/host/tools/`, written with
  `defineTool` from `tool`, and register it in
  `createCommentsHost` of `src/host/service.ts` through `tools/v1` with `alwaysAvailable: true` and an
  `order` exported as a constant from its own file, as `COMMENT_REPLY_ORDER`
  is, that no other registered tool uses.
- Add the test of each change in the same change to
  [`tests/router.test.ts`](tests/router.test.ts), through
  [`tests/support/router.ts`](tests/support/router.ts).
  When the change calls a method of another contract that the harness does
  not fake, add that method to the harness's fake, writing to or reading from
  its shared log.
- When a test needs a folder of `src/` other than `src/host/` and
  `src/contracts/`, add that folder to `include` of
  [`tsconfig.spec.json`](tsconfig.spec.json): the `test` target compiles only
  the folders listed there.
- Update the feature doc [Comments](../../../docs/features/comments.md) with
  any change to what the reader or the agent sees of a comment, and
  [Papercraft](../../../docs/features/papercraft.md) when the change touches
  comments on a papercraft program.

## Verify

- `npx nx run bundle-comments:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-comments:test`: run it after any change under `src/` or
  `tests/`.
- `npx nx run bundle-comments:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or
  `src/contracts/`.

## Generated files

None.
