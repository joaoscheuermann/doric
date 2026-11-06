# OpenUI bundle

`openui` lets a Doric agent answer with UI in the conversation. The agent
writes an OpenUI Lang program in an `openui-lang`
fence of its answer, and the chat draws it while the answer streams: forms,
tables, charts, and the question form with which the agent asks the reader to
decide something. A click on a control goes back to the agent as the reader's
next message, and errors in a drawn program reach the agent at its next prompt.

It is a feature bundle with a host part (the `openui` skill, the error sink and
the question service) and a client part (the fence element and its renderer
chunk), loaded by the `bundle` platform. The [`papercraft`](../papercraft/README.md)
bundle draws its own `papercraft` fences with the same language and this
bundle's contracts. See the [main README](../../../README.md) for Doric as a
whole and [`packages/bundle`](../../../packages/bundle/README.md) for how
bundles work.

## What it provides

- **Fence:** `openui-lang`, drawn by `<openui-fence>`, registered at activation
  with `chat.views/v1.registerFenceRenderer`. No setting governs it.
- **Skill:** `openui` (order 3400, in the index, loaded on demand): the
  language, the built-in components, the question form and how to read a
  `<ui-action>`. Its body is the committed, generated `src/host/skills/openui.md`.
- **Contracts** (`openui/contracts`, browser-safe: no React, no OpenUI):
  - `openui.programs/v1` (host, exposed to the desktop with the scope
    `projectId`, `threadId`): `reportErrors`. Errors a window reports for a
    fence of either tag are kept per Thread and reach the agent at the start
    of the Thread's next prompt as one `validation` instruct. A report for a
    prompt that is neither the Thread's current nor previous one is dropped,
    and each error is delivered at most once.
  - `openui.questions/v1` (host, same scope): `status` and `answer` of a
    question fence.
  - the event `openui.answered/v1`: the reader's answers, written under the
    prompt that took them, naming the question's prompt and digest.
  - the pure modules both fence owners import: the program identity, the fold
    of a Thread's fences into programs (`createProgramFolds`), the question
    built-ins as data, the error codes and the error reporter.

## Programs and revisions

A fence's opener may name an identity after the tag. A later fence with the
same identity holds only the statements that change, and the fold merges them
into the program by statement name; a fence without an identity starts a new
program. Each fence is one revision, keyed by chat as
`<promptId>/<turnSequence>/<index>`, in the state `streaming`, `closed` or
`unterminated`.

## The question form

A fence whose first line is `root = AskForm(…)` is a question: one to five
`AskQuestion`s of two to six `AskOption`s each, with an optional `context`. A
question fence is always a whole program, never a patch. A question is its
prompt and the SHA-256 digest of its parsed questions.

- `status` answers `answered`, with the answers of the Thread's first matching
  `openui.answered/v1` row, else `pending`.
- `answer` sends the formatted answers as the reader's next message by the
  composer's route, then writes `openui.answered/v1`. The first answer is
  final; an answered question is returned unchanged without sending. In an
  agent's Thread, an unknown one or one of another Project it is `unavailable`
  and nothing is sent. Calls for one question run one at a time.

The form's view is a copy of the one `threads`' `ask` drew before `threads`
2.0.0 removed it. The client re-reads a question's state on each live row of
the Thread (`chat.hooks/v1.onThreadUpdateHook`), and registers a projector for
`openui.answered/v1` rows so they draw no block.

## Actions

A click on a control of a drawn program sends its text through
`chat.send/v1.sendAction`, which wraps it in `<ui-action program="…">`. The
text's first line is the action's message; the lines after it are the values
of the form the control belongs to, or the program's `$variables`, as
`<key>: <value>`. It holds at most 16,000 UTF-16 code units. Actions work only
on the latest closed revision of a program in a main Thread; otherwise a line
under the fence says why (a subagent's Thread, a fence still streaming or cut
off, an older revision). While a click is sent the fence stays busy at least
500 ms.

## Entry and renderer chunk

- The client entry (`client/index.js`) holds only the element, the projector
  and the live rows. `<openui-fence>` draws the fence's source until the
  renderer chunk loads, then the chunk's `ConversationFence`.
- The renderer chunk (`client/chunks/renderer.js`, from
  `src/client/chunks/renderer.ts`) holds OpenUI's renderer, the conversation
  library, the checks, the actions and the question form. It is imported once
  per window, at the first fence; a rejected import is not retried.
- The React context the question form reads (`question/fence-context.ts`)
  stays in the chunk, where both its provider and its reader are: the
  contracts entry also runs in the host, and no bundle's contracts import
  React.
- Two sheets: `client/styles.css`, the utilities of the fence element and the
  question form; and `client/chunks/renderer-styles.css`, built from
  `src/client/chunks/renderer-styles.ts`, which is Doric's tokens for OpenUI
  (`src/client/tokens.css`, the layer order `openui, openui-doric`, 42
  `--openui-*` variables set from Doric's tokens) followed by react-ui's
  layered sheet. The entry links the renderer's sheet before it imports the
  renderer.
- **Reserved keyframe name:** react-ui's sheet defines one keyframe without
  the `openui` prefix, `fadeIn`, and layers do not scope keyframe names. No
  Doric source may define `fadeIn`.

## Dependencies

- **Required:** `chat.views/v1@^1.1.0`, `chat.send/v1@^1.1.0`,
  `runtime.threads/v1@^1.5.0`, `runtime.hooks/v1@^1.2.0`, `hooks/v1`,
  `events/v1`, `skills/v1@^1.1.0` and `ui/v1`.
- **Packages:** `@openuidev/lang-core` and `@openuidev/react-lang` 1.0.2,
  `@openuidev/react-ui` 0.18.1, with React 19 and `lucide-react`.

## Design

The specs are [`docs/designs/openui.md`](../../../docs/designs/openui.md) and
[`docs/designs/conversation-openui.md`](../../../docs/designs/conversation-openui.md);
the feature doc is [`docs/features/papercraft.md`](../../../docs/features/papercraft.md).
The code is the reference where they differ.

## Development

```console
npx nx build bundle-openui
npx nx typecheck bundle-openui
npx nx test bundle-openui
```
