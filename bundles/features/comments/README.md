# Comments bundle

`comments` is the registry of anchored comments: a note a reader leaves on an
exact place of something the app can address (an element of a live preview, a
passage of an agent's answer, a file and a line), which the agent reads as an
instruction and answers in the comment's thread. The bundle stores and reads
comments, publishes their two durable events and gives the agent the
`comment_reply` tool. It never interprets a target and draws nothing: the
bundle that owns a target's `kind` draws the target and its comments.

The flow across bundles (drafts on the chat composer's stack, the prompt that
carries them, how each surface draws a thread) is in the feature docs
[Comments](../../../docs/features/comments.md) and
[Papercraft](../../../docs/features/papercraft.md). See
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles are
built and loaded.

## Manifest

[`manifest.json`](manifest.json):

| Field          | Value                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `comments`, version `1.0.0`, engine `doric ^1.0.0`                                                                                              |
| `description`  | Anchored comments on any target the app can address: the registry, its durable events and the attended state it folds back from the Thread log. |
| `provides`     | `comments/v1@1.0.0`, `comments.added/v1@1.0.0`, `comments.resolved/v1@1.0.0`                                                                    |
| `requires`     | `events/v1@^1.0.0`, `runtime.threads/v1@^1.2.0`, `tools/v1@^1.0.0`                                                                              |
| `optional`     | none                                                                                                                                            |
| `desktopScope` | `comments/v1`: `projectId`, `threadId`, `promptId`                                                                                              |

`desktopScope` lets a desktop window call `comments/v1` with those three scope
keys; the desktop refuses any other key
([manifest](../../../docs/architecture/bundles/manifest.md#desktopscope)). The
package exports `comments/contracts`, `comments/contracts/gen/*` (the
protobuf-es code `generate-proto` writes from `proto/`) and `package.json`
([`package.json`](package.json)).

## Parts

The bundle has two parts and no settings, slots, skills, routes or UI.

- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts)), exported
  as `comments/contracts`: the types and schemas below, the reference
  `CommentsV1`, the method specs `commentsMethods`, the two event definitions
  `commentsAddedEvent` and `commentsResolvedEvent`, the schemas
  `commentAnchorSchema`, `commentTargetSchema`, `commentSchema`,
  `commentAddInputSchema` and `commentTargetKeySchema`, and
  `COMMENT_ID_PATTERN`.
- **Host** ([`src/host/index.ts`](src/host/index.ts)). `activate` does, in
  order: provides the `comments/v1` service; registers `comments.added/v1`
  and `comments.resolved/v1` with `events/v1`; registers the `comment_reply`
  tool with `tools/v1` as `{ alwaysAvailable: true, order: 1800 }`. It reads
  no data and holds no state. The host entry also exports `AGENT_AUTHOR`
  (`'agent'`), `COMMENT_REPLY_ORDER` (`1800`), `COMMENT_REPLY_TOOL`
  (`'comment_reply'`), the tool as `commentReplyTool` and its types
  `CommentReplyInput` and `CommentReplyOutput`
  ([`src/host/tools/comment-reply.ts`](src/host/tools/comment-reply.ts)); the
  package does not export the host entry, and nothing outside `src/host/`
  imports these names; the tests import only `activate`
  ([`tests/support/harness.ts`](tests/support/harness.ts)).
- **Process entry** ([`src/host/main.ts`](src/host/main.ts)), for the
  bundle-process runtime
  ([bundle processes](../../../docs/features/bundle-processes.md)).
  `createCommentsHost` serves `comments/v1` and the `comment_reply` tool over
  routed ports of `events/v1`, `runtime.threads/v1` and `tools/v1`
  ([`src/host/routed.ts`](src/host/routed.ts)), and registers
  `comments.added/v1` and `comments.resolved/v1` as loose events with no sink.
  The registry and the tool take the same `CommentsPorts`
  ([`src/host/ports.ts`](src/host/ports.ts)) as the kernel part.

## Contracts used

- `events/v1` (provided by
  [`core`](../../foundation/core/README.md)): `register` for the two events
  at activation and `append` for every write
  ([`src/host/comments.ts`](src/host/comments.ts),
  [`events.ts`](../../../packages/bundle/src/contracts/basic/events.ts)). The
  rows land in the log of the call's Thread through the sink that
  [`runtime`](../../runtime/runtime/README.md) registers for its Thread event
  streams ([`events.ts`](../../runtime/runtime/src/contracts/events.ts)).
- `runtime.threads/v1` (provided by
  [`runtime`](../../runtime/runtime/README.md)): `threadEvents({ id,
afterSequence: 0 })` to read one Thread's whole log, and
  `projectThreads(projectId)` to list a Project's Threads
  ([`src/host/comments.ts`](src/host/comments.ts)).
- `tools/v1` (provided by [`core`](../../foundation/core/README.md)):
  `register` for `comment_reply` ([`src/host/index.ts`](src/host/index.ts),
  [`tools.ts`](../../../packages/bundle/src/contracts/basic/tools.ts)).

## Data shapes

All shapes are in [`src/contracts/index.ts`](src/contracts/index.ts). Every
object schema is loose: fields it does not name are kept.

### `CommentAnchor`

Where in the target the comment sits. `form` is one of four values, and each
form requires its own fields; every other field below is optional on every
form.

| `form`     | Required                     | Meaning                                                    |
| ---------- | ---------------------------- | ---------------------------------------------------------- |
| `source`   | `path`: non-empty string     | A workspace-relative file, with an optional `line`         |
| `selector` | `selector`: non-empty string | An element of the target's derived structure               |
| `point`    | `x`, `y`: numbers            | A free position, with the nearest element named in `label` |
| `range`    | `text`: non-empty string     | Selected text of the target                                |

Optional fields:

- `path: string`, `line: number` (a positive integer), `selector: string`,
  `x: number`, `y: number`, `label: string`, `text: string`.
- `pseudo: '::before' | '::after'`: the pseudo-element of the anchored
  element the comment is on; absent means the element itself.
- The seat, for a kind that draws its target as turns of blocks: `turn:
string` (the turn's key), `block: number` (the 0-based block the selection
  starts in), `at: number` (how far into that block the text starts, counted
  in non-whitespace characters) and `item: number` (the list item it starts
  in). `add` checks the seat (see [Behavior](#behavior)); the schema checks
  only that the four are a string and numbers.

The registry stores every anchor field and interprets none of them.

### `CommentTarget`, `CommentTargetKey`

```ts
interface CommentTarget {
  kind: string; // declared by the bundle that owns the target
  id: string; // identity of the target within its kind
  revision?: number; // an integer, when the target has revisions
  anchor: CommentAnchor;
}

interface CommentTargetKey {
  kind: string;
  id: string;
  revision?: number;
}
```

A target's identity is `kind`, `id` and `revision`; the anchor is not part of
it.

### `Comment`

```ts
interface Comment {
  commentId: string;
  target: CommentTarget;
  text: string;
  author?: string;
  resolved: boolean;
  createdAt: string; // ISO 8601
  inReplyTo?: string; // the root comment; absent on a root
}
```

Threads are flat: `inReplyTo` always names a root, never another reply.

### `COMMENT_ID_PATTERN`

`/^[A-Za-z0-9_-]{1,128}$/`: the ids a caller may choose.

## Contract `comments/v1`

`comments/v1` is a host service of cardinality `one`, provided by the host
part ([`src/host/comments.ts`](src/host/comments.ts)). Its three methods are
exposed to the desktop, so a window may call them as well as any host part.
Each input is checked against its schema in `commentsMethods` before the
method runs; a payload that breaks it is refused with `invalid_input`
([`src/contracts/index.ts`](src/contracts/index.ts)).

```ts
interface Comments {
  add(input: CommentAddInput, call?: CallArg): Promise<Comment>;
  list(input: CommentListInput, call?: CallArg): Promise<readonly Comment[]>;
  resolve(
    input: CommentResolveInput,
    call?: CallArg,
  ): Promise<Comment | undefined>;
}

interface CommentAddInput {
  target: CommentTarget;
  text: string;
  author?: string;
  commentId?: string; // matches COMMENT_ID_PATTERN
  inReplyTo?: string;
}

interface CommentListInput {
  target?: CommentTargetKey;
  kind?: string;
}

interface CommentResolveInput {
  commentId: string;
  resolved: boolean;
}
```

| Method    | Scope it needs                              | Result                                          |
| --------- | ------------------------------------------- | ----------------------------------------------- |
| `add`     | `projectId`, `threadId` and `promptId`      | The comment written, or the one already written |
| `list`    | `projectId`; `threadId` narrows to a Thread | The matching comments, in log order             |
| `resolve` | `projectId`, `threadId` and `promptId`      | The comment in its new state, or `undefined`    |

## Events

Both events are defined in [`src/contracts/index.ts`](src/contracts/index.ts)
and registered by the host part at activation
([`src/host/index.ts`](src/host/index.ts)).

| Type                   | Payload                                                        | Written by                                          |
| ---------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `comments.added/v1`    | `{ commentId, target, text, author?, createdAt?, inReplyTo? }` | `add`, and `comment_reply`                          |
| `comments.resolved/v1` | `{ commentId, resolved }`                                      | `resolve`, and `comment_reply` with `resolve: true` |

The rows live in the call's Thread log, so any bundle that reads that log sees
them.

## Behavior

All of it is in [`src/host/comments.ts`](src/host/comments.ts).

### Reading the log (the fold)

Every read takes a Thread's whole log through `runtime.threads/v1`
`threadEvents`, keeps only the rows whose `projectId` is the call's and whose
`threadId` is the Thread being read, and folds them in log order:

- A `comments.added/v1` row becomes a comment with `resolved: false` and
  `createdAt` from its payload, or the log row's own time when the payload has
  none. A second row with an id the fold already holds is ignored: the first
  row wins.
- A `comments.resolved/v1` row sets `resolved` on a comment the fold already
  holds, and is ignored otherwise.
- A row whose payload breaks its event schema is skipped, without failing the
  read.
- A row is read in either stored encoding: today's JSON, or the message JSON
  that a routed `events/v1` append writes (implicit fields kept). Both coexist
  in the log from S62 until phase 4
  ([`src/host/rows.ts`](src/host/rows.ts)).
- A Thread the runtime does not know reads as no comments.

Nothing is held in the process: a restarted host, a fresh activation, a
replay or a rewind answers what the log holds.

### `add`

1. Trims `text`.
2. Refuses with `invalid_input` a malformed seat: when any of `turn`, `block`,
   `at` and `item` is present, `turn` must be a non-empty string, `block` a
   non-negative integer, and `at` and `item`, when present, non-negative
   integers. An anchor with none of the four passes.
3. Refuses with `invalid_input` an empty trimmed text, and a `commentId` that
   does not match `COMMENT_ID_PATTERN`.
4. Refuses with `invalid_scope` a call whose scope lacks `projectId`,
   `threadId` or `promptId`.
5. When the input names a `commentId` or an `inReplyTo`, folds the call's
   Thread. A comment of that Thread with the chosen `commentId` is returned as
   it stands, resolved or not, and nothing is appended: a retried write never
   duplicates. The same id in another Thread is a different comment.
6. With `inReplyTo`, the named comment must be in the call's Thread, else
   `invalid_input`; `inReplyTo` is set to that comment's root (its own
   `inReplyTo`, or itself). The reply keeps the `target` the caller passed.
7. Builds the comment: `commentId` the chosen one or `comment-<uuid>`,
   `resolved: false`, `createdAt` the current time; fields whose value is
   `undefined` are left out, so an absent `author` stays absent.
8. Appends `comments.added/v1` through `events/v1` with the call's scope, and
   returns the comment. When the append fails the error propagates and
   nothing is written.

### `list`

Refuses with `invalid_scope` a call without `projectId`. With `threadId` in
the scope it folds that Thread; without one it folds every Thread of the
Project, in the order `projectThreads` answers, each in log order. It then
keeps the comments whose `target.kind` equals `kind` when `kind` is given, and
whose target identity (`kind`, `id`, `revision`) equals `target` when `target`
is given; the anchor never takes part.

### `resolve`

Needs the same scope as `add` (`invalid_scope` otherwise) and sees only the
call's own Thread. A `commentId` that Thread does not hold (one of another
Thread or Project included) answers `undefined` and writes nothing. When the
comment already has the asked state, it is returned and nothing is written;
otherwise `comments.resolved/v1` is appended and the comment is returned with
its new state. `resolved: false` reopens a comment. When the append fails the
error propagates and the state is unchanged.

## The `comment_reply` tool

[`src/host/tools/comment-reply.ts`](src/host/tools/comment-reply.ts), built
with `defineTool` from [`tool`](../../../packages/tool/README.md); the tool
registry checks the payload against the input schema before the tool runs
and refuses a payload that breaks it with `invalid_payload`, and wraps an
error the tool throws as `handler_failed` with that error as its `cause`
([`tools.ts`](../../../packages/tool/src/lib/tools.ts)).

```text
comment_reply({ comment_id: string (non-empty), text: string (non-empty), resolve?: boolean })
  -> { commentId: string, inReplyTo: string, resolved: boolean }
```

Both schemas are strict: an unknown field is refused. A `text` of whitespace
alone passes the schema and is refused by `addComment`. The model reads the
description "Answer one review comment the user left, in the comment's thread.
Say what you changed, or ask what is unclear. Set `resolve` to true when the
comment is done." The bundle ships no skill.

It runs in the calling prompt's scope. Each error below is a
`ContractError` the tool throws, so it reaches the caller as the `cause` of
`handler_failed`:

1. Looks `comment_id` up in the call's Thread; an unknown id, one of another
   Thread included, is `invalid_input` ("The comment "<id>" is unknown in this
   conversation; use an id the prompt names.").
2. Takes the root: the comment itself, or the comment its `inReplyTo` names;
   a missing root is `invalid_input`.
3. Writes the answer with `addComment`, the logic behind `add` (so every check
   of `add` applies, but not the method's input schema), with the root's
   `target`, `author: "agent"` and `inReplyTo` the root's id, under a
   generated id.
4. With `resolve: true`, resolves the root with `resolveComment`, the logic
   behind `resolve`.
5. Returns the reply's id, the root's id, and whether the root is resolved
   now.

The bundle registers the tool with no drawing. The chat draws it: it hides the
row of every `comment_reply` call that has not failed and draws the agent's
replies as a reply block in the conversation, folding the log's comment events
into threads ([`comment-threads.ts`](../../desktop/chat/src/client/domain/comment-threads.ts),
[`projector.ts`](../../desktop/chat/src/client/domain/projector.ts)).

## What the bundle does not do

- It writes no draft: a comment reaches the log only when a caller calls
  `add`. Drafts, the prompt that carries comments to the agent and the writes
  after a send belong to the chat composer
  ([Comments](../../../docs/features/comments.md)).
- It draws no comment, thread, pin or tool call, and it resolves no anchor:
  the owner of each `kind` does.
- It enforces no meaning of `kind`, `id`, `revision`, `author` or the anchor
  beyond the schemas and the seat check above.

## Side effects

- Appends `comments.added/v1` and `comments.resolved/v1` rows to the call's
  Thread log, nothing else ([`src/host/comments.ts`](src/host/comments.ts)).
- Registers two event types and one tool at activation
  ([`src/host/index.ts`](src/host/index.ts)).

## Configuration

None: the bundle declares no settings and reads no environment variable.

## Limits

- A chosen `commentId` has 1 to 128 characters of `A-Z`, `a-z`, `0-9`, `_` and
  `-`.
- Every call that reads folds whole Thread logs from sequence 0; a `list`
  without `threadId` folds every Thread of the Project.
- Order is the log's order within a Thread, and the Threads' order from
  `projectThreads` across a Project.
- Threads are one level deep: every reply names the root.

([`src/contracts/index.ts`](src/contracts/index.ts),
[`src/host/comments.ts`](src/host/comments.ts),
[`src/host/tools/comment-reply.ts`](src/host/tools/comment-reply.ts))

## Errors

| Code              | When                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid_input`   | An input that breaks its schema (an anchor without its form's fields, an unknown `form` or `pseudo`, a `commentId` outside the pattern)                |
| `invalid_input`   | `add`: a malformed seat, an empty trimmed text, an `inReplyTo` the Thread does not hold                                                                |
| `invalid_input`   | `comment_reply`: an unknown `comment_id`, a thread with no root, or a text empty once trimmed (reaching the caller as the `cause` of `handler_failed`) |
| `invalid_payload` | `comment_reply`: a payload that breaks the tool's input schema                                                                                         |
| `invalid_scope`   | `add` or `resolve` (or `comment_reply`, as the `cause` of `handler_failed`) without `projectId`, `threadId` and `promptId`; `list` without `projectId` |
| from `events/v1`  | A refused append propagates unchanged and leaves nothing written                                                                                       |

`resolve` of an unknown comment is not an error: it answers `undefined`
([`src/contracts/index.ts`](src/contracts/index.ts),
[`src/host/comments.ts`](src/host/comments.ts),
[`src/host/tools/comment-reply.ts`](src/host/tools/comment-reply.ts)).

## Build and test

Run from the repository root:

```console
npx nx run bundle-comments:typecheck
npx nx run bundle-comments:test
npx nx run bundle-comments:build
```

`build` compiles `src/` with `tsc` and packs the bundle with the `bundle`
build CLI; `test` compiles `src/host`, `src/contracts` and `tests/` to
`dist-tests/` and runs `tests/*.test.js` with `node --test`
([`project.json`](project.json)). The tests in
[`tests/comments.test.ts`](tests/comments.test.ts) activate the host part over
`createTestServices` with a fake Thread log behind `events/v1` and
`runtime.threads/v1` ([`tests/support/harness.ts`](tests/support/harness.ts)).
