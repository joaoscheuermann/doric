# openui

`openui` lets an agent answer with UI in the conversation. The agent writes an
OpenUI Lang program in an `openui-lang` fence of its answer, and the chat draws
it while the answer streams: react-ui's forms, tables and charts, the question
form with which the agent asks the reader to decide something, and diagrams
(flowcharts, sequence, entity and mind-map diagrams) laid out by the app. A
click on a control goes back to the agent as the reader's next message. The
errors of a drawn program show in a card under its fence and reach the agent
as a `validation` instruct.

The bundle also publishes the pure modules every owner of program fences
shares: the program identity, the fold of a Thread's fences into programs, the
error types and the error reporter. The [`papercraft`](../papercraft/README.md)
bundle draws its own `papercraft` fences with them and reports their errors to
this bundle's host.

The flow across bundles is described in the feature docs
[generative UI](../../../docs/features/generative-ui.md),
[diagrams in OpenUI fences](../../../docs/features/openui-diagrams.md) and
[papercraft](../../../docs/features/papercraft.md). How bundles are built and
loaded is described in [`packages/bundle`](../../../packages/bundle/README.md).

## Manifest

[`manifest.json`](manifest.json) declares:

- `id` `openui`, `version` `2.3.4`, `engines.doric` `^1.0.0`.
- `provides`: `openui.programs/v1@1.0.0`, `openui.questions/v1@1.0.0` and the
  event `openui.answered/v1@1.0.0`.
- `requires`: `chat.views/v1@^1.1.0`, `chat.send/v1@^1.1.0`,
  `runtime.threads/v1@^1.8.0`, `runtime.hooks/v1@^1.2.0`, `hooks/v1@^1.0.0`,
  `events/v1@^1.0.0`, `skills/v1@^1.1.0` and `ui/v1@^1.0.0`.
- `optional`: `chat.hooks/v2`.
- `desktopScope`: `openui.programs/v1` and `openui.questions/v1` are called
  from a window with the keys `projectId` and `threadId`.

The package ([`package.json`](package.json)) exports `./contracts`,
`./contracts/gen/*` (the protobuf-es code `generate-proto` writes from `proto/`) and `./package.json`.

## Parts and build output

| Part           | Source                                                                         | Built as                                                                              | What it does                                                                                                     |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| contracts      | [`src/contracts/`](src/contracts/index.ts)                                     | `dist/contracts/`, imported as `openui/contracts`                                     | Contract refs and schemas, the event, the pure modules shared with `papercraft`. No React, no OpenUI.            |
| host           | [`src/host/`](src/host/index.ts)                                               | `dist/host/`                                                                          | The `openui` skill, the error sink `openui.programs/v1`, the question service `openui.questions/v1`.             |
| client         | [`src/client/index.ts`](src/client/index.ts)                                   | `dist/client/index.js`, `dist/client/styles.css`                                      | `<openui-fence>`, the fence renderer registration, the answers projector, the live-row watcher.                  |
| renderer chunk | [`src/client/chunks/renderer.ts`](src/client/chunks/renderer.ts)               | `dist/client/chunks/renderer.js`                                                      | Draws one fence with OpenUI's `Renderer` and the conversation library; actions, checks, question form, diagrams. |
| renderer sheet | [`src/client/chunks/renderer-styles.ts`](src/client/chunks/renderer-styles.ts) | `dist/client/chunks/renderer-styles.css`, and `dist/client/chunks/renderer-styles.js` | Doric's tokens for OpenUI and react-ui's layered sheet.                                                          |
| layout chunk   | [`src/client/chunks/layout.ts`](src/client/chunks/layout.ts)                   | `dist/client/chunks/layout.js`                                                        | `elkjs` and `layout(graph)` for the diagrams ELK lays out.                                                       |

The bundle has no desktop part. The build of `packages/bundle` turns every
`src/client/chunks/<name>.ts` into `client/chunks/<name>.js`, with its CSS
beside it as `client/chunks/<name>.css`
([`parts.ts`](../../../packages/bundle/src/build/parts.ts)); this also emits
`client/chunks/errors-card.js` from
[`chunks/errors-card.ts`](src/client/chunks/errors-card.ts), which the
renderer chunk bundles and nothing loads on its own.

The client entry and the renderer chunk are separate builds. The only relative
module both reach by value is
[`src/client/chat-contract.ts`](src/client/chat-contract.ts), which holds refs
and types matched by contract id, so its two copies behave as one
([`tests/client-split.test.ts`](tests/client-split.test.ts)). The entry
imports no OpenUI package, and the renderer chunk holds no development path of
react-lang (`@openuidev/devtools`, `process.env.NODE_ENV`)
([`tests/client-chunk.test.ts`](tests/client-chunk.test.ts)).

## Contracts provided

All are exported from `openui/contracts`
([`src/contracts/index.ts`](src/contracts/index.ts)).

### `openui.programs/v1` 1.0.0 — the error sink

Provided by the host and exposed to the desktop
([`src/contracts/programs.ts`](src/contracts/programs.ts),
[`src/host/validation.ts`](src/host/validation.ts)). Ref: `OpenuiProgramsV1`;
method specs: `openuiProgramsMethods`.

```ts
interface ProgramErrors {
  reportErrors(input: ProgramErrorsInput, call?: CallArg): Promise<void>;
}

interface ProgramErrorsInput {
  tag: 'openui-lang' | 'papercraft'; // PROGRAM_TAGS
  key: string; // chat's fence key, /^[^/]+\/\d+\/\d+$/ (FENCE_KEY_PATTERN)
  identity: string; // PROGRAM_IDENTITY_PATTERN
  revision: number; // integer ≥ 1
  state: 'closed' | 'unterminated';
  errors: ReportedError[]; // at most 50 (MAX_REPORTED_ERRORS)
}

interface ReportedError {
  code: OpenUIErrorCodeName; // one of OPENUI_ERROR_CODES
  statementId?: string; // /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/ (STATEMENT_ID_PATTERN)
  message?: string; // 1 to 300 UTF-16 code units (MAX_ERROR_MESSAGE)
}
```

`OPENUI_ERROR_CODES` is lang-core 1.0.2's `OpenUIErrorCode` as a value:
`missing-required`, `null-required`, `unknown-component`, `inline-reserved`,
`excess-args`, `type-mismatch`, `unknown-function`, `no-root`,
`runtime-error`, `render-error`, `parse-exception`, `parse-failed`,
`tool-not-found`, `tool-error`, `mcp-error`
([`src/contracts/errors.ts`](src/contracts/errors.ts)); the test build fails
when lang-core's codes differ ([`tests/error-codes.test.ts`](tests/error-codes.test.ts)).

The input schemas (`programErrorsInputSchema`, `reportedErrorSchema`) are
strict. Errors: `invalid_input` for an input that fails them; `invalid_scope`
("openui.programs/v1 needs a call scope with a project and a Thread.") for a
call without `projectId` and `threadId` in its scope. Any other report
resolves, whether or not its errors are kept; delivery is described under
[Errors reaching the agent](#errors-reaching-the-agent).

### `openui.questions/v1` 1.0.0 — the question service

Provided by the host, both methods exposed to the desktop
([`src/contracts/questions.ts`](src/contracts/questions.ts),
[`src/host/questions.ts`](src/host/questions.ts)). Ref: `OpenuiQuestionsV1`;
method specs: `openuiQuestionsMethods`.

```ts
interface Questions {
  status(input: QuestionRef, call?: CallArg): Promise<QuestionState>;
  answer(input: QuestionAnswerInput, call?: CallArg): Promise<QuestionState>;
}

interface QuestionRef {
  promptId: string; // non-empty: the prompt that wrote the question fence (first part of its key)
  questions: AskInput; // the questions as the app parsed them from the closed fence
}
interface QuestionAnswerInput extends QuestionRef {
  answers: AskAnswer[];
}

type QuestionState =
  | { state: 'pending' }
  | { state: 'answered'; answers: AskAnswer[] };
```

Their strict schemas are `questionRefSchema`, `questionAnswerInputSchema` and
`questionStateSchema`.

The question schemas, all strict, where "text" is a string that is not blank
([`src/contracts/questions.ts`](src/contracts/questions.ts)):

- `askInputSchema` (`AskInput`): `context?` text of at most 1,000;
  `questions`, 1 to 5 `AskQuestion`s with distinct ids.
- `askQuestionSchema` (`AskQuestion`): `id` text of at most 64, `question`
  text of at most 500, `options` 2 to 6 `AskOption`s with distinct labels,
  `multiSelect?` boolean, `allowOther?` boolean.
- `askOptionSchema` (`AskOption`): `label` text of at most 120,
  `description?` text of at most 300, `recommended?` boolean.
- `askAnswerSchema` (`AskAnswer`): `id` (non-empty), `options` (the labels
  picked), `other?` (the free answer).

A question is its `promptId` and its digest: the hex SHA-256 of
`JSON.stringify(questions)`. The same questions written by another prompt are
another question. Every call reads the Thread's log again through
`runtime.threads/v1.threadEvents` from sequence 0; nothing is cached
([`src/host/questions.ts`](src/host/questions.ts)).

- `status` answers `answered` with the answers of the first
  `openui.answered/v1` row of the scope's Project and Thread whose
  `questionPromptId` and `digest` match, else `pending`.
- `answer` runs one call at a time per `promptId` and digest. It reads the
  state and returns an `answered` state unchanged, sending nothing. Otherwise
  it checks the answers, sends them, appends the event, and answers
  `{ state: 'answered', answers }`.
  - The check refuses with `invalid_input`, in this order for each answer:
    an unknown question, `The ask has no question "<id>".`; a question
    answered twice, `The question "<id>" is answered twice.`; an unknown
    option, `An answer to "<id>" names an unknown option.`; an option named
    twice, `An answer to "<id>" names an option twice.`; more than one option
    on a question without `multiSelect: true`,
    `The question "<id>" takes one option at most.`; an `other` on a question
    with `allowOther: false`, `The question "<id>" takes no free answer.`.
    Then any question without an answer,
    `Unanswered questions: <id>, <id>.`. A question answered with no option
    and no `other` is skipped, which is allowed.
  - The text sent is `formatAnswers`: `Answers to your questions:`, a blank
    line, then for each question in order `<n>. <question>` and on the next
    line three spaces and its values: the picked labels in option order, then
    the trimmed `other` when not blank, joined with `; `, each newline inside
    a value followed by three spaces; `(skipped)` when there is none.
  - It is sent by the composer's route through `runtime.threads/v1`: the
    Thread must exist in the scope's Project and must not be an agent's
    Thread; with an active prompt it is a `steer` of that prompt (`steered` or
    `queued`); otherwise, when the queue is paused, empty and has no current
    or resumable item, `resumeQueue` first (it must answer `resumed`), then a
    `prompt` (it must answer `accepted`).
  - Then `events/v1.append` writes `openui.answered/v1` under the Project,
    the Thread and the prompt that took the answers.

Errors (`ContractError` codes): `invalid_scope` for a call without
`projectId` and `threadId`; `invalid_input` for an input that fails its schema
or answers that do not fit; `unavailable` with the message "The Thread did not
take the answers." and `details` `{ status: 'missing' }` (no Thread, another
Project, no queue), `{ status: 'forbidden' }` (an agent's Thread),
`{ status: <runtime status> }` (a steer, resume or prompt that was not taken)
or `{ reason: <message> }` (a runtime call that rejected). A rejected log read
or append rejects with that error; an append that fails after the send leaves
the answers delivered and the question `pending`.

### `openui.answered/v1` — the answer event

Declared with `defineEvent` and registered with `events/v1` at host activation
([`src/contracts/questions.ts`](src/contracts/questions.ts),
[`src/host/index.ts`](src/host/index.ts)). Payload, strict:

```ts
{ questionPromptId: string /* non-empty */; digest: string /* 64 hex chars */; answers: AskAnswer[] }
```

It is written under the prompt that took the answers and names the question's
prompt and digest. The first row of a question is its final answer.

### Pure modules

Each is pure and browser-safe; `papercraft` and this bundle's client import
them.

**Identity** ([`src/contracts/identity.ts`](src/contracts/identity.ts)).
Identities are per tag.

```ts
const WRITTEN_IDENTITY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ANONYMOUS_IDENTITY_PATTERN = /^_[1-9][0-9]{0,8}$/;
const PROGRAM_IDENTITY_PATTERN = /^(?:[a-z][a-z0-9-]{0,63}|_[1-9][0-9]{0,8})$/;
function writtenIdentity(info: string): string | undefined;
function anonymousIdentity(ordinal: number): string;
```

`writtenIdentity` is the second whitespace-separated word of a fence's info
string when it matches `WRITTEN_IDENTITY_PATTERN`, else `undefined`; it never
throws. `anonymousIdentity` is `_<ordinal>` for an integer from 1 to
999,999,999 and throws a `RangeError` otherwise.

**Fold** ([`src/contracts/fold.ts`](src/contracts/fold.ts)).

```ts
interface ProgramFence {
  key: string;
  info: string;
  body: string;
  state: 'streaming' | 'closed' | 'unterminated';
}

interface ProgramRevision {
  key: string;
  identity: string; // written, or the anonymous `_<n>`
  revision: number; // 1-based among the fences of this tag and identity that have a revision
  program: string; // the full program as of this fence
  base?: string; // the previous revision's program; absent for revision 1
  complete: boolean; // false when the fence is `streaming` or `unterminated`
  question: boolean; // a question fence: never merged, never a base
  mergeFailed?: true; // `merge` threw: `program` is then `base`
}

type Merge = (existing: string, patch: string) => string; // lang-core's `mergeStatements`
type IsQuestion = (firstLine: string) => boolean;

interface ProgramFold {
  revisions(
    fences: readonly ProgramFence[],
  ): ReadonlyMap<string, ProgramRevision>;
}
interface ProgramFolds {
  hold(threadId: string, tag: string): { fold: ProgramFold; release(): void };
}

function completedStatements(fence: ProgramFence): string;
function firstCompletedLine(fence: ProgramFence): string | undefined;
function createProgramFold(merge: Merge, isQuestion?: IsQuestion): ProgramFold;
function createProgramFolds(
  merge: Merge,
  isQuestion?: IsQuestion,
): ProgramFolds;
```

- `completedStatements` is the whole body of a `closed` fence, otherwise
  every line but a last one not ended by a newline; `firstCompletedLine` is
  the first of those lines that is not blank. Both delegate to
  `runtime/contracts`.
- `revisions(fences)` takes one tag's fences in transcript order and maps the
  key of each fence that has a first completed line to its revision. It never
  throws.
  - `isQuestion(firstLine)` makes it a question fence; without `isQuestion` no
    fence is one.
  - Its identity is the written identity (never for a question fence), else
    `_<i>` with `i` its 1-based position in the list.
  - When the identity has an earlier non-question program, that is `base` and
    `program` is `merge(base, completed)`; otherwise `program` is the completed
    statements.
- The fold keeps its last call and merges again only from the first fence
  whose key, info, body or state changed; the result for a key depends only on
  the fences up to it.
- `createProgramFolds` keeps one fold per Thread and tag: every holder of the
  same Thread and tag gets the same fold while any hold is live; `release` is
  idempotent; a fold whose last hold is released is dropped one microtask later
  unless it is held again.

**Error reporter and card lines**
([`src/contracts/report.ts`](src/contracts/report.ts),
[`src/contracts/errors.ts`](src/contracts/errors.ts)).

```ts
interface ErrorReporterInput {
  tag: ProgramTag;
  key: string;
  identity: string;
  revision: number;
  mergeFailed: boolean; // the revision's `mergeFailed`
  check: () => readonly ReportedError[]; // the owner's own check, run once, at the report
  map: (error: OpenUIErrorLike) => ReportedError | undefined; // undefined drops it
  send: (input: ProgramErrorsInput) => Promise<void>; // reportErrors in the fence's scope
}

interface ErrorReporter {
  onError(
    errors: readonly OpenUIErrorLike[],
    state: 'streaming' | 'closed' | 'unterminated',
  ): void;
  sent(): boolean;
}

interface ShownError {
  code?: string; // absent for a note that is not an OpenUI error
  statementId?: string; // present only when it matches STATEMENT_ID_PATTERN
  message: string; // 1 to 300 characters
}

function createErrorReporter(input: ErrorReporterInput): ErrorReporter;
function shownErrors(input: {
  mergeFailed: boolean;
  owned: readonly ReportedError[];
  rendered: readonly OpenUIErrorLike[];
}): readonly ShownError[];

type ProgramTag = 'openui-lang' | 'papercraft';
interface OpenUIErrorLike {
  code: string;
  message: string;
  statementId?: string;
  component?: string;
  hint?: string;
  severity?: 'warning';
}
```

- `onError` never throws and never awaits. It ignores `streaming` calls and
  acts once, at the first `closed` or `unterminated` call. It builds the
  errors in order: a `parse-exception` with the message "This patch could not
  be merged into the previous revision; write the whole program again." when
  `mergeFailed`, then `check()`, then each error `map` keeps that is not a
  warning. It drops codes outside `OPENUI_ERROR_CODES`, keeps the first 50,
  removes a `statementId` that fails its pattern, and cuts a message over 300
  code units to 299 and `…`. A `closed` fence with no error sends nothing; an
  `unterminated` one always sends, with `errors: []` when it has none. A
  rejected `send` is dropped.
- `sent()` is true once `onError` called `send`, whatever its promise does.
- `shownErrors` gives the merge error, then `owned` (a missing message shows
  its code), then `rendered` without warnings, with codes outside the list
  kept; the first line per code and statement; the first 50; the statement
  pattern and the message length clamped as above. It never throws.

**Question built-ins** ([`src/contracts/builtins.ts`](src/contracts/builtins.ts)).
`defineQuestionBuiltins(define, renderers)` calls the given `defineComponent`
three times and returns `[AskOption, AskQuestion, AskForm]`, with positional
props `label, description, recommended`, then
`id, question, options, multiSelect, allowOther`, then `questions, context`,
taken from the question schemas.

## Contracts used

- `chat.views/v1`: `registerFenceRenderer` with `tag` `openui-lang` and
  `elementTag` `openui-fence`, and `registerProjector` for
  `openui.answered/v1`; reached
  with `services.whenAvailable` ([`src/client/index.ts`](src/client/index.ts)).
- `chat.send/v1`: `sendAction` for a click on a control
  ([`src/client/chunks/renderer.ts`](src/client/chunks/renderer.ts)).
- `chat.hooks/v2` (optional): `onThreadUpdateHook`, through `hooks/v1.whenAvailable`
  ([`src/client/index.ts`](src/client/index.ts)).
- `runtime.threads/v1`: `instruct` for validation; `threadEvents`, `thread`,
  `steer`, `queue`, `resumeQueue` and `prompt` for questions
  ([`src/host/validation.ts`](src/host/validation.ts),
  [`src/host/questions.ts`](src/host/questions.ts)).
- `runtime.hooks/v1`: `onPromptStartedHook`, through `hooks/v1.whenAvailable`
  ([`src/host/index.ts`](src/host/index.ts)).
- `events/v1`: `register` and `append` of `openui.answered/v1`
  ([`src/host/index.ts`](src/host/index.ts),
  [`src/host/questions.ts`](src/host/questions.ts)).
- `skills/v1`: `register` of the `openui` skill
  ([`src/host/index.ts`](src/host/index.ts)).
- `ui/v1`: `define` of `<openui-fence>`
  ([`src/client/index.ts`](src/client/index.ts)).
- `runtime/contracts` (module): `completedStatements`, `firstCompletedLine`,
  `isQuestionLine` (`/^root\s*=\s*AskForm\(/`)
  ([`src/contracts/fold.ts`](src/contracts/fold.ts),
  [`src/client/folds.ts`](src/client/folds.ts)).

The client reaches `chat.views/v1`, `chat.send/v1` and `chat.hooks/v2`
through its own structural copy of chat's shapes and the members it calls
(`watchFences` is declared but not called), and does not import
`chat/contracts`; the ids and shapes are chat's
([`src/client/chat-contract.ts`](src/client/chat-contract.ts)):

```ts
interface ChatThreadEvent {
  projectId: string;
  threadId: string;
  promptId: string;
  sequence: number;
  type: string;
  event: unknown; // the row's payload as stored, with its own `type` key
  createdAt: string;
}
interface ProjectorSpec<S = unknown> {
  eventTypes: readonly string[];
  initial(): S;
  reduce(
    state: S,
    event: ChatThreadEvent,
  ): { state: S; blocks: readonly ChatBlock[] };
}
// ChatBlock: { id: string; type: string; promptId: string; sequence: number; data: unknown }
interface ChatFence {
  key: string; // `${promptId}/${turnSequence}/${index}`
  projectId: string;
  threadId: string;
  promptId: string;
  turnSequence: number;
  index: number;
  info: string;
  body: string;
  state: 'streaming' | 'closed' | 'unterminated';
}
interface ChatFenceView {
  fence: ChatFence;
  origin: 'user' | 'agent';
  fences: readonly ChatFence[];
}
interface ChatViews {
  registerProjector(spec: ProjectorSpec, call?: CallArg): Disposable; // registration_conflict
  registerFenceRenderer(
    spec: { tag: string; elementTag: string },
    call?: CallArg,
  ): Disposable;
  watchFences(
    input: { projectId: string; threadId: string; tag: string },
    listener: StreamListener<readonly ChatFence[]>,
    call?: CallArg,
  ): Disposable; // declared, not called by this bundle
}
const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

interface ChatActionInput {
  projectId: string;
  threadId: string;
  program: string;
  text: string;
}
interface ChatActionResult {
  status: 'accepted' | 'refused';
}
interface ChatSend {
  sendAction(input: ChatActionInput, call?: CallArg): Promise<ChatActionResult>;
}
const ChatSendV1 = ref<ChatSend>('chat.send/v1');

// ChatHooksV2 = defineHooks('chat.hooks/v2', { onThreadUpdateHook }), an `observe` hook whose
// input is ThreadUpdateInput:
type ThreadUpdateInput = {
  projectId: string;
  threadId: string;
  threadName: string;
  update:
    | { kind: 'event'; event: ChatThreadEvent }
    | { kind: 'updated'; thread: unknown };
};
```

## Host activation

[`src/host/index.ts`](src/host/index.ts) provides `openui.programs/v1` and
`openui.questions/v1`, registers `openui.answered/v1`, registers
`validation.promptStarted` as `onPromptStartedHook` once `runtime.hooks/v1` is
available, and registers the skill. The cleanup disposes the skill, the hook
and every pending validation timer.

The same services also run as the bundle's own process
([`src/host/main.ts`](src/host/main.ts), `createOpenuiHost`): it serves
`openui.programs/v1` and `openui.questions/v1`, registers
`openui.answered/v1`, a `runtime.hooks/v1` handler and the skill, and its
services answer `unavailable` until activation. A routed request is parsed
again with the same zod schemas, so a questions digest matches the kernel's;
stored `openui.answered/v1` rows read the same in both encodings. The skill is
never read at import: the kernel reads it in activation beside the compiled
module, the process with `context.assets.read` (which needs the manifest's
`host.assets`, slice S62). The 200 ms validation timer's instruct runs
detached.

### The `openui` skill

How skills a bundle registers are listed and loaded is described in
[skills](../../../docs/features/skills.md).

Name `openui`, no allowed tools, `order` 3400, `alwaysAvailable` false (listed
in the skills index and loaded on demand), description "Answers with UI the app
draws while you write: OpenUI Lang programs in openui-lang fences, with forms,
tables, charts and question forms for the reader. Load it before writing an
openui-lang or papercraft fence, or before asking the reader to decide
something." Its body is [`src/host/skills/openui.md`](src/host/skills/openui.md),
read at activation and trimmed. No setting governs it.

The file is generated by
[`tests/client/skill-text.test.ts`](tests/client/skill-text.test.ts): OpenUI's
prompt builder over react-ui's library, the question built-ins and the diagram
components, with Doric's rules held in that test (`doricRules`,
`diagramRules`). The test fails when the file differs from the generated text
and writes the file when `OPENUI_SKILL_UPDATE=1`.

## Drawing a fence

### The element and the renderer chunk

At client activation ([`src/client/index.ts`](src/client/index.ts)) the bundle
defines `<openui-fence>` with `ui/v1` (a React element with the prop `view`,
in `StrictMode`), and, once `chat.views/v1` is available, registers it as the
renderer of `openui-lang` fences and registers the answers projector, which
claims `openui.answered/v1` rows and draws no block
([`src/client/answers-projector.ts`](src/client/answers-projector.ts)). A
projector registration another bundle already holds is left to it. No setting
governs the renderer.

The element ([`src/client/fence-element.tsx`](src/client/fence-element.tsx))
draws nothing for a `view` that is not a valid `ChatFenceView`. Otherwise it
starts loading the renderer chunk at its first render: once per window, the
loader appends a `<link rel="stylesheet">` to
`client/chunks/renderer-styles.css` and imports `client/chunks/renderer.js`; a
rejected import is never retried
([`src/client/folds.ts`](src/client/folds.ts)). Once loaded, the window's
folds are `createProgramFolds(mergeStatements, isQuestionLine)` with
react-lang's `mergeStatements`. The element holds the fold of its Thread and
`openui-lang` while mounted, folds the view's fences of that tag (the tag is
the first word of the info string), and draws:

1. the fence's source with "Writing…", or "Incomplete: the answer ended before
   the fence closed" when `unterminated`, while the fence has no completed line
   that is not blank;
2. the source with "The UI renderer did not load: <message>" after a failed
   import;
3. the source with "Drawing…" until the chunk is loaded and the fold has a
   revision for the fence;
4. the chunk's `ConversationFence` with the revision, `latest` (no later fence
   has a revision of the same identity) and `superseded` (a question fence
   with a later `closed` question fence whose program passes `askInputSchema`).

`ConversationFence` ([`src/client/chunks/renderer.ts`](src/client/chunks/renderer.ts))
draws react-lang's `Renderer` with the conversation library, `isStreaming`
while the fence streams and `publishObservability: false`. Its text is the raw
fence body while revision 1 streams and the revision's `program` otherwise. It
provides the fence context the question form and the diagrams read
([`src/client/question/fence-context.ts`](src/client/question/fence-context.ts)):
`view`, `revision`, `superseded`, `services`, `watchAnswers`, `interactive`
and `layout` (the `layout` prop, for tests and stories, else the window's
layout loader). A crash outside OpenUI's own handling draws "This UI failed to
draw: <message>" in place of the program and is passed to the reporter as a
`render-error`. An `unterminated` fence has the footer "Incomplete: the answer
ended before the fence closed".

### The conversation library

[`src/client/library.ts`](src/client/library.ts) extends react-ui's
`openuiLibrary` with `AskForm`, `AskQuestion`, `AskOption`, the four diagram
components and their twelve parts, and overrides `Modal` with the same props
and description, drawn as a bordered `section` inside the fence (titled by
`title`, shown while its `open` state field is `true` or the string
`'true'`). `parseProgram(program)`
parses with this library's JSON schema and root, with one parser per window.

### Actions

A click on a control calls `onAction` with react-lang's `ActionEvent`
([`src/client/actions.ts`](src/client/actions.ts),
[`src/client/chunks/renderer.ts`](src/client/chunks/renderer.ts)).

- Actions are blocked, and the line under the fence says why, in an agent's
  Thread ("Actions are off in a subagent's thread: only the main thread takes
  the reader's messages"), on an `unterminated` fence ("Actions are off: this
  UI was cut off before it was complete"), while it streams ("Actions work once
  the UI is complete") and on a revision that is not the latest ("Actions work
  in the latest version of this UI"). A blocked fence's wrapper is `inert`.
- `open_url` sends nothing and shows its URL as the line. Another type than
  `continue_conversation` shows "Not sent: action type <type> is not
  supported"; an empty message shows "Not sent: the action has no message".
- The text is up to three sections joined by a blank line: the trimmed
  message; the action's parameters (`context` first) as `<key>: <value>`
  lines; and the values of the form the control belongs to as
  `<form>.<field>: <value>`, or without a form the program's `$variables` as
  `$<name>: <value>`. A string is written as is, anything else as JSON, a field
  object as its `value`, and a value that writes nothing is left out. A text
  over 16,000 UTF-16 code units shows "Not sent: the action's text is over
  16,000 characters".
- The text is sent with `chat.send/v1.sendAction`, with the fence's
  `projectId` and `threadId`, `program` the revision's identity and `text`.
  One click per fence is in flight; the line
  reads "Sending…", the wrapper is `inert` and `aria-busy` for at least 500 ms.
  `refused` shows "Not sent: the thread did not take the message"; a rejection
  shows "Not sent: <first 300 characters of its message>".

### The question form

`AskForm`'s component ([`src/client/question/ask-form.tsx`](src/client/question/ask-form.tsx))
ignores its props and reads the question from the fence's program with
`questionOf` ([`src/client/question/ask-input.ts`](src/client/question/ask-input.ts)),
which parses it and maps the root to `AskInput`, giving `input` when it passes
`askInputSchema`, else the first issue's message, and the questions that pass
`askQuestionSchema`. It draws, in this order:

1. "A question must be the root of its own fence" when the fence is not a
   question fence;
2. the questions under "Not asked: only the main thread can ask the reader."
   in an agent's Thread;
3. "Writing the question…", with the questions read so far disabled, while it
   streams;
4. the questions under "Not asked: the question was cut off" when
   `unterminated`;
5. the schema's issue as an alert when the questions are invalid;
6. otherwise nothing until `status` answers (a failed read reads `pending`),
   then the answers under "Answered" when answered, the questions under
   "Replaced by a later question" when `superseded`, or the form.

The form ([`src/client/question/ask.tsx`](src/client/question/ask.tsx),
[`src/client/question/picks.ts`](src/client/question/picks.ts)) shows one
question at a time with an `n/N` count, option rows as radio or checkbox, a
"Type your answer..." row unless `allowOther` is `false`, Back from the second
question, Next and Send. In the form to answer, Next is always enabled, and
Send is enabled except while an answer is pending; in the disabled form drawn
while the fence streams, every control is disabled. Send calls `answer` with
one answer per question in order (a question without picks gives
`options: []`). A rejected `answer` shows "Could not send. Try again."
(`role="status"`), keeps the picks and enables Send again
([`ask.tsx`](src/client/question/ask.tsx)). A resolved `answer` sets the
form's state to the result it returns
([`ask-form.tsx`](src/client/question/ask-form.tsx)).

A bound form reads its status again when a live event can change it: with
`chat.hooks/v2` present, `noticeThreadUpdate` calls each mounted form of the
event's Project and Thread on an `openui.answered/v1` row whose
`questionPromptId` is the form's prompt and on every `history.truncated` row;
a read that finishes after a newer one is ignored
([`src/client/answer-changes.ts`](src/client/answer-changes.ts)). Without
`chat.hooks/v2` a form reads its status only when it mounts or its question
changes.

### Errors shown to the reader

The program check ([`src/client/check.ts`](src/client/check.ts)) reads the
program once per call, one statement per line, the statement name being the
identifier before `=`:

- each `Query` and `Mutation` statement: `tool-not-found`, "Query and Mutation
  are not available; write the data as literals.";
- each line with `@OpenUrl(`: `runtime-error`, "OpenUrl is disabled; write the
  link as text";
- in a fence that is not a question, each line with `AskForm(`:
  `runtime-error`, "A question must be the root of its own fence: write root =
  AskForm(…) as its first line.";
- the diagram findings (see [Diagrams](#diagrams)), merged into the first
  `runtime-error` of their statement.

`programCheck` is that list. `check`, which the reporter sends, adds two
question lines on `root`: in an agent's Thread "Not asked: only the main thread
can ask the user. Put the question in your result instead, so your coordinator
can ask the user or decide.", and for a closed question fence whose questions
are invalid "Invalid question: <issue>". `map` reports OpenUI's own errors
with their message, cut to 300 code units; an `unknown-component` message is
cut to leave room for the hint "Repository components and Export exist only in
papercraft fences."

The card ([`src/client/chunks/errors-card.ts`](src/client/chunks/errors-card.ts))
is drawn under a fence that is not streaming when
`shownErrors({ mergeFailed, owned: programCheck(revision), rendered })` gives
lines: a `section` labelled "Program errors", the header "1 error" or "N
errors" with an alert icon, one line per error with its statement name before
the message and no code, and the footer "Sent to the agent." once the
reporter's `sent()` is true.

## Errors reaching the agent

Each drawn revision has one reporter, with `check` and `map` above and `send`
calling `openui.programs/v1.reportErrors` in the fence's scope
([`src/client/chunks/renderer.ts`](src/client/chunks/renderer.ts)). The host
([`src/host/validation.ts`](src/host/validation.ts)) keeps one entry per
Thread, for both tags, in memory:

- An entry is created or moved at each `onPromptStartedHook` of the Thread:
  the started prompt becomes the current one and the earlier one the previous;
  the listed-error ids of other prompts are forgotten.
- A report is dropped when the Thread has no entry (no prompt started since
  the host started) or when its key's prompt (the part before the first `/`)
  is neither the current nor the previous prompt.
- Each error is listed once per tag, key, code and statement, as the line
  `<tag> <identity> r<revision> <statement>: <code> <text>`, where
  `<statement>` is the statement id or `-` and `<text>` the error's message or
  its code's fixed text. An `unterminated` report adds the line
  `<tag> <identity> r<revision>: cut off before the fence closed`. Past 50
  waiting lines a line is counted, not kept.
- Lines of a `closed` report wait 200 ms, then go out as one `instruct` of
  `runtime.threads/v1` with `id` the Thread, `reason: 'validation'` and
  `promptId` the current prompt: a steer while it runs, a queued prompt once
  it has finished. At most 3 such instructs go out per prompt that a
  validation instruct did not start. A `queued` answer holds every later line
  until that prompt starts; a status other than `steered` or `queued`, or a
  rejection, puts the lines and their count of unlisted errors in front of the
  lines waiting for the Thread's next prompt start, and gives the instruct
  back to the budget. The timer does not retry them.
- Lines of an `unterminated` report, lines past the budget and lines held
  behind a queued instruct wait for the Thread's next prompt start, where the
  hook sends every waiting line in one `validation` instruct to the started
  prompt. A prompt start while a timer's instruct is in flight sends nothing,
  and the lines keep waiting. A rejection of the prompt-start instruct rejects
  the hook and drops its lines. A prompt started by this bundle's validation
  instruct does not restore the budget.
- The instruct's text is "Some OpenUI fences you wrote have errors. Each line
  is `<tag> <identity> r<revision> <statement>: <code> <text>`. Fix a program
  by writing a fence with the same tag and identity: a patch of the named
  statements, or the whole program when you no longer see it.", a blank line,
  the lines, and "and N more errors were not listed" when lines were counted
  out.
- An error without a message shows the fixed text of its code (`FIXED_TEXT`):
  - `missing-required`: omits a required argument
  - `null-required`: passes null for a required argument
  - `unknown-component`: calls a component the library does not have
  - `inline-reserved`: uses a call inline that must be a statement of its own
  - `excess-args`: passes more arguments than the component takes; the extra
    ones were dropped
  - `type-mismatch`: passes an argument of the wrong type
  - `unknown-function`: calls a function or action that does not exist here
  - `no-root`: has no root statement
  - `runtime-error`: failed while its values were evaluated
  - `render-error`: failed while it was drawn
  - `parse-exception`: could not be parsed
  - `parse-failed`: is not valid OpenUI Lang; a program starts with root = …
  - `tool-not-found`: calls a tool that is not available; write the data as
    literals
  - `tool-error`: calls a tool that failed
  - `mcp-error`: calls a tool server that failed
- At most 1,000 Threads keep an entry; the Thread whose prompt started longest
  ago is removed first.

## Diagrams

The library adds four diagram components, defined in
[`src/client/diagram/definitions.ts`](src/client/diagram/definitions.ts). Only
the diagram draws; its parts draw nothing and are read from its props.

| Component         | Arguments, in order                                                                                   | Parts                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Flowchart`       | `nodes`, `edges?`, `groups?`, `direction?` (`down` default, `right`)                                  | `Node(id, label, shape?, group?)`, `shape` `box` (default), `round`, `diamond`, `circle`, `cylinder`; `Edge(from, to, label?, line?, arrow?)`, `line` `solid` (default) or `dashed`, `arrow` `end` (default) or `none`; `Group(id, label, parent?)`                                                                                                             |
| `SequenceDiagram` | `participants`, `steps?`                                                                              | `Participant(id, label)`; `Message(from, to, text, kind?)`, `kind` `call` (default), `reply`, `async`, `from` equal to `to` a self-message; `Note(text, over)`, `over` a list of participant ids; `Fragment(kind, sections)`, `kind` `loop`, `opt`, `alt`, `par` (else read as `loop`); `Section(label, steps)`. `steps` holds `Message`, `Note` and `Fragment` |
| `EntityDiagram`   | `entities`, `relations?`, `notation?` (`er` default, `class`), `direction?` (`down` default, `right`) | `Entity(id, name, fields?, methods?)`, methods plain strings; `Field(name, type?, key?)`, `key` `pk`, `fk`, `pk-fk`, `unique`; `Relation(from, to, kind?, label?, fromCount?, toCount?)`, `kind` `association` (default), `inherits`, `implements`, `composition`, `aggregation`, `dependency`, counts `1`, `0..1`, `*`, `1..*`                                 |
| `MindMap`         | `root`, `layout?` (`right` default, a mind map; `down`, a tree)                                       | `Topic(label, children?)`, recursive                                                                                                                                                                                                                                                                                                                            |

Limits: per `Flowchart` 100 nodes, 200 edges, 25 groups nested 4 deep; per
`SequenceDiagram` 20 participants and 200 steps (messages, notes and
fragments, counted depth-first); per `EntityDiagram` 60 entities and 120
relations, fields and methods unlimited; per `MindMap` 300 topics and 8
levels. Every type: labels, names, fields, methods and texts cut at 120 code
points (ending in `…`), ids of 1 to 64 characters
(`TEXT_LIMITS`, `FLOWCHART_LIMITS`, `SEQUENCE_LIMITS`, `ENTITY_LIMITS`,
`MINDMAP_LIMITS` in [`definitions.ts`](src/client/diagram/definitions.ts)).

**Reading and findings.** One pure reading per type turns the props into the
drawn model and its findings, in a fixed order
([`model.ts`](src/client/diagram/model.ts),
[`sequence-model.ts`](src/client/diagram/sequence-model.ts),
[`entity-model.ts`](src/client/diagram/entity-model.ts),
[`mindmap-model.ts`](src/client/diagram/mindmap-model.ts),
[`read.ts`](src/client/diagram/read.ts)). A text in a finding is quoted as
JSON, cut to 23 characters and `…` when it is longer than 24 (`quote` in
[`read.ts`](src/client/diagram/read.ts)); a mind-map `<path>` is the topic
labels from the root, each cut the same way, joined with `›` with a space
on each side, and quoted once. Each rule and its finding:

- An id outside 1 to 64 characters: the part is not drawn,
  `<Type> "<id>" is not drawn because an id has 1 to 64 characters.`
- A repeated id: only the first is drawn,
  `<Type> "<id>" appears twice, and only the first is drawn.`
- Parts past a count limit are not drawn,
  `The <Diagram> has <N> <parts>, and only the first <limit> are drawn: split the diagram.`
- A label, name, field, method or text longer than 120 code points is cut to
  119 and `…`: `The label of <Part> is cut at 120 characters.` (`<Part>` is
  `Node "<id>"`, `Group "<id>"`, `Edge "<from>"→"<to>"`,
  `Participant "<id>"`, `Relation "<from>"→"<to>"` or `Topic <path>`);
  `The label of Section "<label>" is cut at 120 characters.`;
  `The text of Message "<from>"→"<to>" is cut at 120 characters.` and
  `The text of Note "<text>" is cut at 120 characters.`;
  `The name of Entity "<id>" is cut at 120 characters.`,
  `A field of Entity "<id>" is cut at 120 characters.` and
  `A method of Entity "<id>" is cut at 120 characters.`
- An empty label or name of a `Node`, `Group`, `Entity` or `Participant` is
  drawn as the part's id, with no finding.
- A reference to an unknown id: the part is not drawn,
  `Edge "<from>"→"<to>" names no Node "<missing>", so it is not drawn.`,
  `Message "<from>"→"<to>" names no Participant "<missing>", so it is not drawn.`
  and
  `Relation "<from>"→"<to>" names no Entity "<missing>", so it is not drawn.`;
  a note over no participant or an unknown one,
  `Note "<text>" names no Participant "<missing>", so it is not drawn.`
  (without ` "<missing>"` when `over` names none).
- `Node "<id>" names no Group "<group>", so it is drawn outside any group.`
- `Group "<id>" names no Group "<parent>" as parent, so it is drawn at the top level.`,
  `Group "<id>" is in a parent loop, so it is drawn at the top level.` and
  `Group "<id>" nests deeper than 4 levels, so it is drawn at the top level.`
- `Group "<id>" holds no node, so it is not drawn.`
- `Fragment "<kind>" "<label>" holds no step, so it is not drawn.`, with the
  label of its first section.
- `Topic <path> is deeper than 8 levels, so it and its subtopics are not drawn.`
- A sequence part in the wrong list is not drawn,
  `A <Type> in <prop> is not drawn: <prop> holds <allowed>.`, with `<prop>`
  `steps` or `sections` and `<allowed>` the part names joined with `, ` and a
  final `and`.
- An empty diagram: `The Flowchart has no nodes.`,
  `The SequenceDiagram has no participants.`,
  `The EntityDiagram has no entities.` or `The MindMap has no topics.`
- Under `er`, every relation reads as `association` and methods are not read,
  with no finding.

`diagramCheck(root)` ([`diagram/check.ts`](src/client/diagram/check.ts)) walks
the parsed program with `DIAGRAM_PARTS`: a part outside its diagram gives
`<Part> draws only inside a <Diagram>.`, and a diagram inside another gives
`<Inner> is not drawn inside a <Outer>.` while its contents add nothing. A
statement's findings become one `runtime-error` on that statement (or the
nearest enclosing one, else `root`) with the message
`Diagram problems (<N>): 1. <finding> 2. <finding> …`, at most 300 code units.
Findings are added in order while they and the closing ` <K> more not shown.`
fit, and the message is `Diagram problems (<N>): <N> more not shown.` when not
even the first fits. `mergeDiagramErrors` appends this message after `; ` to
the message of the first `runtime-error` of the same statement, rebuilt to fit
the room left of 300 code units, or adds it as its own error when there is
none ([`diagram/check.ts`](src/client/diagram/check.ts)).

**Outline, layout and drawing.** Each view shows a text outline of its parts
with a note while it cannot draw: outside a conversation fence ("Diagrams are
drawn only in the conversation."), while its fence streams ("The diagram is
drawn when its fence is complete.") and while laying out ("Drawing the
diagram…"). Once the fence is `closed` or `unterminated` it is laid out once
per mount and drawn model, late results are dropped, and a failure shows "This
diagram could not be drawn: " with the first 200 characters of the error and
is not reported ([`view.ts`](src/client/diagram/view.ts),
[`outline.tsx`](src/client/diagram/outline.tsx)). Labels are measured in the
drawing's font and wrapped ([`measure.ts`](src/client/diagram/measure.ts)).

- `Flowchart` and `EntityDiagram` are laid out with ELK `layered` (hierarchy
  handling, orthogonal routing) and `MindMap` with ELK `mrtree`, in the layout
  chunk, one seeded ELK instance per window, so a graph always gives the same
  result ([`chunks/layout.ts`](src/client/chunks/layout.ts),
  [`graph.ts`](src/client/diagram/graph.ts)). A `class` diagram's counts are
  ELK end labels, an `inherits` or `implements` relation is laid out from
  `to` to `from`, and a `class` diagram laid out `right` is laid out `down`
  transposed. A graph ELK cannot lay out is refused with
  `Invalid layout graph: <problem>`; an ELK failure rejects with ELK's error.
- The renderer chunk loads the layout chunk through one loader per window at
  the first ELK layout; a rejected load rejects that layout and every later
  one ([`layout-loader.ts`](src/client/diagram/layout-loader.ts)). The two
  chunks share only types: `LayoutGraph` (keyed node, group and edge sizes,
  `direction`, `algorithm?`, `groupPadding`, optional end labels; no label,
  id or color) and `LayoutResult` (boxes and edge points by key)
  ([`layout-types.ts`](src/client/diagram/layout-types.ts)).
- `SequenceDiagram` is laid out by
  [`sequence-layout.ts`](src/client/diagram/sequence-layout.ts) in the
  renderer chunk (columns in participant order, rows in step order, fragments
  as boxes around their rows) and never loads the layout chunk.
- Each diagram is one `svg[role="img"]` labelled with the outline's header;
  labels are text nodes. Every color is a role over Doric's tokens or
  `--foreground` mixed over `--background`
  ([`canvas.tsx`](src/client/diagram/canvas.tsx),
  [`colors.ts`](src/client/diagram/colors.ts),
  [`sequence-picture.tsx`](src/client/diagram/sequence-picture.tsx),
  [`entity-picture.tsx`](src/client/diagram/entity-picture.tsx),
  [`mindmap-picture.tsx`](src/client/diagram/mindmap-picture.tsx)).

**Area, pan and zoom.** `DiagramFrame` is `aspect-square w-full` with its
height capped at
`calc(100svh - 40px - var(--doric-titlebar-height,40px) - 32px)`
([`canvas.tsx`](src/client/diagram/canvas.tsx)). The drawing starts
fitted, never above 100 %, and refits on resize until the reader pans or
zooms; the scale stays within 25–400 %, with the math of `desktop/ui/viewport`
([`gestures.ts`](src/client/diagram/gestures.ts)). A diagram is interactive
when its fence's actions are not blocked: a focusable area labelled
`<type>, pan and zoom` with the toolbar Zoom out, the percentage, Zoom in and Fit to
view; a press focuses it, Escape blurs it, a drag pans, Ctrl or Cmd with the
wheel zooms at the pointer, and a plain wheel pans only while focused.
Otherwise it is static and fitted. While a click of its fence is sending, the
wrapper is `inert` but the diagram keeps its toolbar and viewport.

## Styles

- `client/styles.css` ([`src/client/styles.css`](src/client/styles.css)): the
  Tailwind utilities of the element and the question form, against
  `desktop/ui/tailwind.css`, scanning this bundle's client, `packages/desktop/src`
  and the client folders of the `layout`, `chat`, `settings`, `account` and
  `workspace` bundles, so that the sheet re-emits no shared class after
  another sheet's responsive variants
  ([`tests/workspace-sheet.test.ts`](tests/workspace-sheet.test.ts)).
- `client/chunks/renderer-styles.css`: [`src/client/tokens.css`](src/client/tokens.css),
  which declares the layer order `openui, openui-doric` and sets 42
  `--openui-*` variables on `:root` from Doric's tokens in `openui-doric`, so a
  fence follows Doric's theme and portaled popovers take them too; then
  react-ui's layered sheet. The entry links it before importing the renderer.
- react-ui's sheet defines one keyframe without the `openui` prefix, `fadeIn`;
  layers do not scope keyframe names.

## Data and persistence

- The Thread's log holds the only durable data: `openui.answered/v1` rows,
  appended through `events/v1` under the Project, the Thread and the prompt
  that took the answers. A rewind that removes the row makes the question
  `pending` again ([`src/host/questions.ts`](src/host/questions.ts)).
- The host keeps validation entries in memory only: per Thread the current and
  previous prompt, the waiting lines, the listed-error ids, the dropped count,
  the budget and the queued prompt; a host restart loses them
  ([`src/host/validation.ts`](src/host/validation.ts)).
- A window keeps its folds and the open forms' watches in memory
  ([`src/contracts/fold.ts`](src/contracts/fold.ts),
  [`src/client/answer-changes.ts`](src/client/answer-changes.ts)). Form values
  and `$variables` live only in the drawn `Renderer`, and nothing stores them
  ([`src/client/chunks/renderer.ts`](src/client/chunks/renderer.ts)).

## Configuration

The bundle has no setting and reads no environment variable at run time
([`src/host/index.ts`](src/host/index.ts),
[`src/client/index.ts`](src/client/index.ts)). `OPENUI_SKILL_UPDATE=1` is
read only by the skill-text test.

## Dependencies

`@openuidev/lang-core` and `@openuidev/react-lang` 1.0.2, `@openuidev/react-ui`
0.18.1, `react` and `react-dom` 19, `lucide-react`, `zod` 4, `elkjs` 0.11.1,
and the workspace packages `bundle`, `desktop` and `runtime`
([`package.json`](package.json)). `elkjs` (Eclipse Public License 2.0) is only
in the layout chunk, whose header keeps ELK's notices and where its source is
available ([`src/client/chunks/layout.ts`](src/client/chunks/layout.ts)).

## Development

Run from the repository root ([`project.json`](project.json), Nx project
`bundle-openui`):

```console
npx nx run bundle-openui:build      # tsc --build, the client tsc, then the bundle build
npx nx run bundle-openui:typecheck
npx nx run bundle-openui:test       # builds first; runs tests/*.test.ts and tests/client/*.test.ts with node --test
```

Tests under `tests/` are DOM-free host and contract tests over a fake
`runtime.threads/v1` ([`tests/support/host.ts`](tests/support/host.ts)); tests
under `tests/client/` boot `happy-dom`
([`tests/client/support/dom.ts`](tests/client/support/dom.ts)) and draw
through `ConversationFence` compiled from source
([`tests/client/support/fence.ts`](tests/client/support/fence.ts)); only
[`tests/client-chunk.test.ts`](tests/client-chunk.test.ts) reads the built
chunks under `dist/`. Stories under
`stories/` are wrapped by [`.storybook/preview.tsx`](.storybook/preview.tsx).

After an upgrade of `@openuidev/react-ui` or `@openuidev/react-lang` that
changes the prompt, or a change of a rule in the skill-text test, regenerate
the skill:

```console
OPENUI_SKILL_UPDATE=1 npx nx run bundle-openui:test
```
