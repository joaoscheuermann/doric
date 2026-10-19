# Comments bundle

`comments` lets you point at the exact thing you mean, such as an element of a
live preview or a passage of an agent's reply, and leave a note the agent reads
as an instruction. The agent answers in the comment's thread, says what it
changed or asks what is unclear, and resolves the comment when it is done.

It is a feature bundle with a host part only: the comment registry, its two
durable events and the `comment_reply` tool, loaded by the `bundle` platform.
Drafting and drawing comments belong to the bundles that own each target: the
chat composer and conversation, and the
[`papercraft`](../papercraft/README.md) canvas. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## Why it matters

- **Feedback with an address.** Every comment carries an anchor, so "make this
  bigger" arrives with the file and line, selector or text it is about.
- **One registry for anything.** The registry never interprets a target, so an
  artifact revision, a message or any future target uses the same service.
- **A real conversation per comment.** Replies form flat threads, and the
  agent's answers land in them instead of in loose chat messages.
- **Nothing to lose.** The Thread log is the only record; a restarted host, a
  replay or a rewind answers exactly what the log holds.

## What it provides

- **Tool:** `comment_reply`, always available, at global model-visible
  position 1800. The bundle ships no skill; the tool's description says when
  to use it, and `papercraft_preview` points the agent to it.
- **Contract:** `comments/v1` (host) with `add`, `list` and `resolve`, exposed
  to the desktop with the `projectId`, `threadId` and `promptId` scope.
- **Events:** `comments.added/v1` and `comments.resolved/v1`.

The bundle provides no UI of its own.

## The `comment_reply` tool

```text
comment_reply({ comment_id, text, resolve? })
  -> { commentId, inReplyTo, resolved }
```

- `comment_id` is the id the prompt names (`comment-<uuid>`); an id unknown in
  the caller's Thread is `invalid_input`.
- The answer is written as a comment with `author: "agent"`, the root
  comment's target, and `inReplyTo` set to the root, even when `comment_id`
  names a reply.
- With `resolve: true` it also resolves the root comment.

## Targets and anchors

A comment's target names what it is about; the bundle that owns the target's
`kind` decides what `id`, `revision` and the anchor mean.

```text
{ kind, id, revision?, anchor }
```

| Anchor form | Required fields | Typical use                                     |
| ----------- | --------------- | ----------------------------------------------- |
| `source`    | `path`          | A stamped element of a built preview (`line`)   |
| `selector`  | `selector`      | An element of the target's derived structure    |
| `point`     | `x`, `y`        | A free position, with the nearest element named |
| `range`     | `text`          | A selection of the target's text                |

Each form may also carry the other optional fields (`line`, `label`, …). Today
the targets are a `papercraft` preview revision (kind `artifact`) and a chat
message (kind `message`, anchor `range`).

## How it works

- **Writing:** `add` appends `comments.added/v1` to the call's Thread and needs
  `projectId`, `threadId` and `promptId` (`invalid_scope` otherwise).
- **Ids:** a caller may choose `commentId` (`/^[A-Za-z0-9_-]{1,128}$/`).
  Adding an id the Thread already holds returns that comment and appends
  nothing, so a retried flush never duplicates. Without one, the registry
  generates `comment-<uuid>`.
- **Threads:** `inReplyTo` is normalized to the thread's root and must exist in
  the same Thread, so threads stay flat.
- **Reading:** `list` needs `projectId` and filters by target (`kind`, `id`,
  `revision`, never the anchor) or by `kind`. It reads the call's Thread when
  the scope names one, else every Thread of the Project.
- **Resolving:** `resolve({ commentId, resolved })` sees only the caller's own
  Thread, can reopen a comment, and writes `comments.resolved/v1` only when the
  state changes.
- **No state:** `list` and `resolve` fold the log again through
  `runtime.threads/v1`; nothing is held in the process.

A draft is never written here. In the desktop app, comments wait on the chat
composer's stack and reach the log only after the prompt that carries them is
accepted; the chat client then shows comment threads as `open`, `await` (the
agent replied last) or `done`. `GROUNDING.md` describes that flow in full.

## Design

The design, in Portuguese and including open decisions, is in
[`docs/architecture/bundles/comments.md`](../../../docs/architecture/bundles/comments.md).
`GROUNDING.md` remains the contract for what is implemented.

## Development

```console
npx nx build bundle-comments
npx nx typecheck bundle-comments
npx nx test bundle-comments
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
