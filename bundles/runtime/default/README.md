# default

`default` is the default agent: the agent loop that runs every prompt of a
Doric Thread. For one prompt it builds the system prompt, offers the model
every registered tool and its own `load_skill`, calls the Thread's model,
saves the provider history as it goes, and compacts a long history so the
agent keeps working within the model's context window. It also serves the
agents a Thread can be spawned as, and its client part draws each
`load_skill` call in the conversation.

The feature this bundle implements, across bundles, is described in
[docs/features/default-agent.md](../../../docs/features/default-agent.md);
the coding workflow it ships is described in
[docs/features/coding-workflow.md](../../../docs/features/coding-workflow.md).
How bundles are built and loaded is in
[`packages/bundle`](../../../packages/bundle/README.md).

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                                                                    |
| `id`              | `default` (equal to the `name` of [`package.json`](package.json))                                                                      |
| `version`         | `2.8.0`                                                                                                                                |
| `engines.doric`   | `^1.10.0`                                                                                                                              |
| `description`     | "The default agent: system prompt, skills, tools, model resolution and provider history."                                              |
| `provides`        | `executor/v1@1.5.0`, `default.hooks/v1@1.0.0`, `default.agents/v1@1.0.0`                                                               |
| `requires`        | `tools/v1@^1.0.0`, `skills/v1@^1.0.0`, `models/v1@^1.2.0`, `host-config/v1@^1.1.0`, `hooks/v1@^1.0.0`, `log/v1@^1.0.0`, `ui/v1@^1.0.0` |
| `optional`        | `runtime.lease/v1`, `runtime.workspace/v1`, `chat.views/v1`, `default.skill-sources/v1`                                                |

The package exports `./contracts` ([`src/contracts/index.ts`](src/contracts/index.ts))
and `./package.json`. It declares no slot.

## Parts

| Part      | Folder                                               | What it does                                                                                                                                                                        |
| --------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts | [`src/contracts/`](src/contracts/index.ts)           | Declares `default.hooks/v1`, `default.agents/v1` and `default.skill-sources/v1`, with their types and schemas.                                                                      |
| host      | [`src/host/`](src/host/index.ts)                     | Provides `executor/v1` and `default.agents/v1`, and defines `default.hooks/v1`. Runs in the host's generation process, next to `runtime`, which calls the executor for each prompt. |
| client    | [`src/client/`](src/client/index.ts)                 | Defines the element `default-skill-call` and registers it as the drawing of `load_skill` calls in the conversation.                                                                 |
| skills    | [`src/skills/`](src/skills/coding-workflow/SKILL.md) | Ships the `coding-workflow` skill, which the loader registers through `skills/v1` for the bundle.                                                                                   |

The bundle has no desktop part. The build copies every `.md` file below
`src/host` into `dist/host`, since the host part reads its templates and agent
files at import ([`packages/bundle/src/build/cli.ts`](../../../packages/bundle/src/build/cli.ts)).

### Activation

`activate` of the host part ([`src/host/index.ts`](src/host/index.ts)):

1. loads the built-in agents with `loadBuiltInAgents`; when one is invalid it
   throws `Built-in agent "<path>" is invalid: <reason>.` and the bundle
   provides nothing ([`src/host/agents/definitions.ts`](src/host/agents/definitions.ts));
2. provides `default.agents/v1` over the built-in agents;
3. defines `default.hooks/v1` through `hooks/v1` and provides the executor,
   which receives the hook handle, the clock (`() => new Date()`) and the
   built-in agents.

`activate` of the client part defines `default-skill-call` through `ui/v1`
and, while a provider of `chat.views/v1` is available, registers it for
`load_skill`; its cleanup disposes both ([`src/client/index.ts`](src/client/index.ts)).

## Contracts it provides

### `executor/v1` 1.5.0

The contract is declared in `runtime/contracts`
([`bundles/runtime/runtime/src/contracts/executor.ts`](../../runtime/runtime/src/contracts/executor.ts));
`default` is its provider, with cardinality one. The `runtime` bundle
requires it (`^1.4.0`) and calls it for every prompt. The service is defined
by the id `ExecutorV1.id` with the method schemas `executorMethods`
([`src/host/index.ts`](src/host/index.ts)). Its shape:

```ts
interface Executor {
  // One prompt. call.scope = { projectId, threadId, promptId }; call.signal aborts it.
  run(
    input: { thread: ExecutorThread; job: PromptJob; session: PromptSession },
    call?,
  ): Promise<{ text: string }>;
  // Records the prompt's turn boundary once (an existing boundary wins).
  checkpoint(
    input: { history: HistoryReader; promptId: string },
    call?,
  ): Promise<HistoryPatch>;
  // The history a rewind leaves, or undefined when the prompt has no boundary.
  rewind(
    input: {
      history: HistoryReader;
      promptId: string;
      removedPromptIds: string[];
    },
    call?,
  ): Promise<HistoryPatch | undefined>;
  // The history formats this executor reads.
  formats(call?): string[];
  // On-demand compaction of an idle Thread; call.scope carries the compaction's own promptId.
  compact(
    input: {
      thread: ExecutorThread;
      session: PromptSession;
      policy: { tailMinMessages: number; summaryMaxChars: number };
    },
    call?,
  ): Promise<ExecutorCompactionResult>;
}

type ExecutorThread = Thread & {
  agent?: {
    name: string;
    source: 'built-in' | 'workspace';
    instructions: string;
  };
};
interface PromptJob {
  id: string;
  prompt: string;
  source: InputSource;
}
interface HistoryReader {
  format: string | undefined;
  read(part: string): Promise<unknown>;
}
interface HistoryPatch {
  format: string;
  parts: Record<string, unknown>;
}
interface PromptSession {
  history: HistoryReader;
  record(entry: { history?: HistoryPatch; event?: unknown }): Promise<void>;
  steers?(): Promise<{ prompt: string; source: InputSource }[]>;
  attachment?(id: string): Promise<AttachmentContent | undefined>;
}
type ExecutorCompactionResult =
  | {
      status: 'compacted';
      summaryId: string;
      condensedMessages: number;
      retainedMessages: number;
      tokensFreed: number;
    }
  | {
      status: 'refused';
      reason: 'disabled' | 'missing_history' | 'nothing_to_compact';
    }
  | { status: 'failed'; code: 'summarizer_failed' | 'unsafe_boundary' };
```

`thread` is the public `Thread` of `runtime/contracts`; its `agent`, when
present, also carries the agent's `instructions`. The `session` is local: it
is passed as an object, and every history and event write of the executor
goes through `session.record`, which redacts, sanitizes, persists and
publishes, and keeps the runtime's persistence retry. What each method does
is described below: `run` in [One prompt run](#one-prompt-run),
`checkpoint`, `rewind` and `formats` in [Provider history](#provider-history),
`compact` in [Compaction](#compaction).

The inputs of `run`, `checkpoint`, `rewind` and `compact` (and `compact`'s
`policy`) are strict schemas, and `formats` takes no argument: an input with
another key or a value of the wrong type fails with a `ContractError`
`invalid_input` before the method runs; a `thread` whose `agent` lacks a
string `instructions` fails the same way (`executorMethods` in
[`executor.ts`](../../runtime/runtime/src/contracts/executor.ts)).

### `default.hooks/v1` 1.0.0

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) as
`DefaultHooksV1` and defined by the host part through `hooks/v1`
([`src/host/index.ts`](src/host/index.ts)). One hook:

| Hook                       | Kind        | Input                        | When                                                                                                 |
| -------------------------- | ----------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `onBeforeModelRequestHook` | `transform` | `{ system: string }`, strict | Before every model request of a prompt, under the prompt's call; the model receives what it answers. |

`call.scope` names the prompt (`projectId`, `threadId`, `promptId`) and
`call.signal` aborts with it ([`src/host/executor.ts`](src/host/executor.ts)).
Handlers run one after another, each receiving the output of the one before;
a handler that throws, runs past its deadline (`DEFAULT_HOOK_DEADLINE_MS`,
10,000 ms) or answers a value outside the input schema is reported and
skipped, and the next one receives the value it received
([`bundles/foundation/core/src/shared/hooks.ts`](../../foundation/core/src/shared/hooks.ts)).
`default` registers no handler of its own. A bundle registers one through
`hooks/v1`, with `default.hooks/v1` under its `requires` or `optional`:

```ts
services
  .use(HooksV1)
  .use(DefaultHooksV1)
  .onBeforeModelRequestHook(({ system }) => ({
    system: `${system}\n\n# Project rules\n\nUse tabs.`,
  }));
```

### `default.agents/v1` 1.0.0

The agents a Thread can be spawned as. Declared in
[`src/contracts/index.ts`](src/contracts/index.ts) as `DefaultAgentsV1`, with
the method schemas `defaultAgentsMethods`; provided by `agentsService`
([`src/host/agents/definitions.ts`](src/host/agents/definitions.ts)).
Host-only: no method is exposed to a window.

```ts
// /^[a-z0-9][a-z0-9_-]{0,63}$/u — exported as agentNamePattern
interface AgentSummary {
  name: string; // matches agentNamePattern
  description: string; // never empty
  source: 'built-in' | 'workspace';
  model?: string; // non-empty when present
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
interface AgentDefinition extends AgentSummary {
  instructions: string; // at most 64,000 characters
}
interface DefaultAgents {
  list(call?): Promise<AgentSummary[]>; // input: none
  resolve(input: { name: string }, call?): Promise<AgentDefinition>;
}
```

The schemas `agentSummarySchema`, `agentDefinitionSchema` and
`agentSummariesSchema` are strict.

- `list` answers the agents in effect for the working directory of the
  Thread under `call.scope` (read through `runtime.workspace/v1`): the
  built-ins not hidden by a workspace file, in shipped order, then the valid
  workspace agents in sorted file-name order. With no known working directory
  it answers the built-ins only. It never rejects because of the workspace.
- `resolve({ name })` answers one agent with its raw instructions, chosen by
  the same rule. A workspace agent is read whole and checked again. It fails
  with a `ContractError`:

  | Code                 | When                                                            | Message and details                                                                                                 |
  | -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
  | `invalid_input`      | `name` does not match the pattern, or the input has another key | The schema check, before any read.                                                                                  |
  | `not_found`          | No agent of that name                                           | `Agent "<name>" is not defined. Defined agents: <a>, <b>.` or `… No agent is defined.`; details `{ name, agents }`. |
  | `invalid_definition` | The workspace file of that name is invalid or cannot be read    | `Agent "<name>" is invalid: <reason>.`; details `{ name, path, reason }`.                                           |

  A workspace file of that name is resolved even when a built-in of the same
  name exists, and fails as `invalid_definition` when it is invalid. For an
  unchanged workspace, `resolve` succeeds for exactly the names `list`
  answers, except a file longer than 4,096 bytes whose instructions cite a
  name that is not a prompt variable: `list` shows it, `resolve` fails on it.

How agents are defined and read is in [Agents](#agents).

## Contract it declares and does not provide

### `default.skill-sources/v1` 1.0.0

The version is recorded in the `provides` of each provider's manifest (for
example [`bundles/features/mcp/manifest.json`](../../features/mcp/manifest.json));
`default` lists the bare id under `optional`.

An extension point: a host contract of cardinality many, which a bundle
provides to offer the agent skills. `default` declares it in
[`src/contracts/index.ts`](src/contracts/index.ts) (`SkillSourcesV1`,
`skillSourcesMethods`) and lists it under `optional`.

```ts
interface SkillSourceEntry {
  group?: string; // non-empty when present: a second part of the id, such as an MCP server's slug
  name: string; // non-empty; unique with the source and the group
  description: string;
  reference: string; // non-empty; what read takes; only the source reads it
}
interface SkillSources {
  // The skills offered to the prompt of call.scope, whose working directory is cwd.
  list(input: { cwd: string }, call?): Promise<{ skills: SkillSourceEntry[] }>;
  // One skill's text, and an optional sentence that says where it comes from.
  read(
    input: { reference: string },
    call?,
  ): Promise<{ origin?: string; text: string }>;
}
```

All schemas are strict. A source is named by the bundle id that provides it
(`whenAvailable` gives it); a provider whose bundle id is `cwd` is ignored,
since `cwd/` names the workspace skills
([`src/host/skills/sources.ts`](src/host/skills/sources.ts)). A `list` must
answer within 5,000 ms; the source bounds the time a `read` may take. A
bundle becomes a source by listing `default.skill-sources/v1@1.0.0` under
`provides`, adding `default` to its package dependencies, and providing the
contract with `{ cardinality: 'many' }`:

```ts
import { SkillSourcesV1, skillSourcesMethods } from 'default/contracts';

services.provide(
  defineService(
    SkillSourcesV1,
    {
      list: defineMethod({
        ...skillSourcesMethods.list,
        execute: async ({ cwd }, call) => ({ skills: await mine(call, cwd) }),
      }),
      read: defineMethod({
        ...skillSourcesMethods.read,
        execute: async ({ reference }) => ({ text: await readMine(reference) }),
      }),
    },
    { cardinality: 'many' },
  ),
);
```

`mcp`, for example, provides it for the skills of a Project's MCP servers.
How the executor reads the sources is in [Skills](#skills).

## Contracts it uses

| Contract                              | Used for                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/v1`                            | `list(call)`: the tools of the prompt, offered to the model ([`src/host/executor.ts`](src/host/executor.ts)).                                                                                                                                                                                                                                                                                                               |
| `skills/v1`                           | `list(call)`: the bundle skills, split by `alwaysAvailable` ([`src/host/skills/sources.ts`](src/host/skills/sources.ts)).                                                                                                                                                                                                                                                                                                   |
| `models/v1`                           | `resolve({ providerId, model, effort? })` for the language model, `inputModalities({ providerId, model })` for what it reads ([`src/host/executor.ts`](src/host/executor.ts), [`src/host/compact.ts`](src/host/compact.ts)).                                                                                                                                                                                                |
| `host-config/v1`                      | `current(call)`: the configuration of a run and of a compaction ([Configuration](#configuration)).                                                                                                                                                                                                                                                                                                                          |
| `hooks/v1`                            | Defines `default.hooks/v1` ([`src/host/index.ts`](src/host/index.ts)).                                                                                                                                                                                                                                                                                                                                                      |
| `log/v1`                              | The warnings `Thread execution unavailable` and `Skill source left out` ([`src/host/executor.ts`](src/host/executor.ts), [`src/host/skills/sources.ts`](src/host/skills/sources.ts)).                                                                                                                                                                                                                                       |
| `ui/v1`                               | Defines the element `default-skill-call` ([`src/client/index.ts`](src/client/index.ts)).                                                                                                                                                                                                                                                                                                                                    |
| `runtime.lease/v1` (optional)         | `describe` and `exec` for the OS probe and the scans of `.agents/skills` and `.agents/agents`; `readFile` for a workspace skill and a workspace agent ([`src/host/prompts/variables.ts`](src/host/prompts/variables.ts), [`src/host/skills/sources.ts`](src/host/skills/sources.ts), [`src/host/agents/definitions.ts`](src/host/agents/definitions.ts), [`src/host/skills/load-skill.ts`](src/host/skills/load-skill.ts)). |
| `runtime.workspace/v1` (optional)     | `cwd(call)`: the Thread's working directory now ([`src/host/skills/sources.ts`](src/host/skills/sources.ts)).                                                                                                                                                                                                                                                                                                               |
| `chat.views/v1` (optional)            | `registerToolRenderer` for `load_skill` ([`src/client/index.ts`](src/client/index.ts)).                                                                                                                                                                                                                                                                                                                                     |
| `default.skill-sources/v1` (optional) | `list` and `read` of every source ([`src/host/skills/sources.ts`](src/host/skills/sources.ts), [`src/host/skills/load-skill.ts`](src/host/skills/load-skill.ts)).                                                                                                                                                                                                                                                           |

Without a provider of an optional contract, what depends on it is left out:
no `os` line, no workspace skills or agents, no mid-run change, no drawing of
`load_skill`, no source's skills. The code imports `runtime/contracts`,
`host-config/contracts` and, as types only, `chat/contracts`; it also uses
the packages `agent`, `llms`, `messages`, `tool`, `bundle` and `mustache`
([`package.json`](package.json)).

## One prompt run

`run` ([`src/host/executor.ts`](src/host/executor.ts)) builds everything
afresh for each prompt:

1. It throws if `call.signal` is already aborted, and wraps the session in the
   coalescing writer ([Writes](#writes)); every later write goes through it.
2. It reads the stored `messages` and `meta`
   ([Provider history](#provider-history)). The run resumes when the prompt
   already has a turn boundary and the stored history is longer than it: the
   agent continues that history without appending the input again.
3. It reads the configuration through `host-config/v1` and resolves the
   Thread's execution ([Model](#model)); an unavailable execution fails the
   run here.
4. It starts reading the prompt variables, lists the tools of `tools/v1`, and
   reads the skills ([Skills](#skills)) and the workspace agents
   ([Agents](#agents)) of `thread.cwd` in parallel. A Thread running as an
   agent is not offered the `coding-workflow` skill.
5. It resolves the language model and its input modalities through
   `models/v1`, and wraps the provider to read attachments
   ([Attachments](#attachments)).
6. It answers every tool call of the history's last assistant turn that has
   no result with the tool result `The host was restarted while this tool call
was running, so its result was lost. Call it again if you still need it.`,
   marked `incomplete`: a call is answered rather than run again.
7. It builds the system prompt ([The system prompt](#the-system-prompt)) and
   creates an agent of `packages/agent` with the provider, model, effort, the
   tools ([Tools](#tools)), a fresh tool-call store and the message store.
   The agent's system prompt is a function that passes the built text
   through `onBeforeModelRequestHook` before every request.
8. It measures context pressure once with the length of the enveloped input
   ([Compaction](#compaction)), then streams the agent over the input in its
   envelope ([Input envelope](#input-envelope)), with `resume`, the signal,
   `maxTurns: execution.maxTurns` and the tool result cap.
9. Before every model request after the first, it reads the agents and the
   skills again and gives the model at most one "Agents changed" and one
   "Skills changed" message, in that order ([Mid-run changes](#mid-run-changes)).
10. When the session has `steers`, each input that arrives while the run
    works reaches the model in its source's envelope. A steer from a bundle
    with `retain: true` is recorded in `meta.retained` under
    `<bundleId>:<reason>` at the index where the run stores it.

For each streamed event the run:

- records it; a `response.started` event gains the run's `providerId`;
- saves the history with the event when the event is `response.finished`,
  `tool.finished` or `agent.steered`;
- keeps the last `contextWindow` of `response.started` and the token counts of
  `usage`, and measures pressure again after `response.finished`;
- runs one forced condensation when an `error` event reads as a context
  overflow, and the run still fails with the provider's error;
- checks the signal, and keeps the answer text of `agent.finished`.

`run` resolves with `{ text }`, the agent's final answer. When it ends —
completed, aborted or failed — it saves the history once more, after the
deltas it still held. A thrown context-overflow error first triggers one
forced condensation, whose own failure is ignored.

When a tool call fails with `handler_failed` whose cause chain holds the code
`generation_lost`, and the signal is aborted, the generation process that ran
the tool exited: the run saves the history as it stands, with the call
unanswered, records no failure, saves nothing more when it ends, and rejects
with the signal's reason, so the prompt pauses and its next run answers the
call (step 6).

## The system prompt

The system prompt is `system.md` rendered with the run's prompt variables,
followed, after a blank line, by these sections, each only when it is not
empty, separated by blank lines ([`src/host/executor.ts`](src/host/executor.ts)):

1. `# Agent: <name>`, for a Thread running as an agent: `agent.md` with the
   agent's name and its instructions, themselves rendered with the run's
   prompt variables. Instructions that cite a name other than a prompt
   variable, hold a partial or do not parse make the run reject before its
   first model request, with the template error named `agent <name>`.
2. `# Agents` ([Agents](#agents)).
3. `# Skills` ([Skills](#skills)).

The text stays the same for the whole run; each request carries it as
`onBeforeModelRequestHook` answers it. Human and child Threads get the same
prompt.

[`system.md`](src/host/prompts/system.md) has the sections
`# Role & Objective`, `# Sandbox`, `# Working Directory`, `# Inputs`,
`# Review Comments`, `# Final Response` and `# Environment`. It tells the
agent to complete the request in the Project's sandbox from the persisted
history; that other Threads share the sandbox, so it checks a file before
editing it and never reverts changes it did not make; to use tools rather
than guess; that each Thread has a working directory, starting at
`/workspace`, which the `cwd` tool reports and changes; to work from a
repository's root, since a repository's skills and agents are listed only
from the working directory, and to load the matching skills there; to
initialize a repository for a deliverable meant to be kept and to ask first
for an experiment; how inputs arrive (the five envelopes, `<message>` and
`<ui-action>` inside a `<user-request>`); how review comments arrive
(`<comments>`, `<target>`, `<comment>`) and that each is answered with the
`comment_reply` tool; and to keep the final response concise.

### Prompt variables

[`src/host/prompts/variables.ts`](src/host/prompts/variables.ts) reads them
once at the start of each run; they do not change until the run ends.

| Name       | Value                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `os`       | `<PRETTY_NAME> (<uname -srm>)` of the sandbox, e.g. `Debian GNU/Linux 12 (bookworm) (Linux 6.1.0 x86_64)`; absent when it cannot be read. |
| `date`     | The calendar day `YYYY-MM-DD` in `timezone`, never a time of day.                                                                         |
| `timezone` | The configuration's `profile.timezone`, else the host's zone.                                                                             |
| `user`     | `{ name }`, present only when the configuration's `profile.name` is set; cited as `user.name`.                                            |

`os` comes from one `runtime.lease/v1` exec of
`uname -srm && . /etc/os-release && printf '%s\n' "$PRETTY_NAME"` with a
5,000 ms timeout. Every run calls the lease's `describe`; the value is cached
in memory per Project id and lease id for the life of the service, and only a
non-empty value is cached. A missing provider, a rejection, a non-zero or
null exit code or an empty line leaves `os` out, and the next run probes
again. An unknown time zone makes the run reject with a `RangeError`.

### Prompt templates

Seven texts the model receives whole are Markdown templates rendered with
`mustache`: `system.md`, `agent.md`, `agents.md`, `agents-changed.md`,
`skills-catalog.md`, `skills-changed.md` and `loaded-skills.md`, in
`src/host/prompts/` (for example [`system.md`](src/host/prompts/system.md)). Tool descriptions, that of
`load_skill` included, stay in the tool's `defineTool`. Compaction builds
its texts in TypeScript instead: the summarizer's system prompt and the transcript's
labels in [`summarize.ts`](src/host/compaction/summarize.ts), and the
`[Context summary]` header of a summary in
[`markers.ts`](src/host/compaction/markers.ts) ([Compaction](#compaction)).
Short tool results and notes are also built in TypeScript: the interrupted
call's result in [`executor.ts`](src/host/executor.ts), the image notes in
[`attachments.ts`](src/host/attachments.ts), and the answers and errors of
`load_skill` in [`load-skill.ts`](src/host/skills/load-skill.ts).
[`src/host/prompts/templates.ts`](src/host/prompts/templates.ts):

- `loadTemplate(url, names)` reads a template synchronously when its module
  is imported, removes exactly one trailing newline and checks it: every
  `name`, `&`, `#` and `^` tag, at any depth, must cite one of `names`,
  compared whole (`user.name` included); comments and delimiter changes are
  allowed. It throws `Template "<file>" cites undeclared name "<name>".`,
  `Template "<file>" includes partial "<name>"; partials are not supported.`
  or `Template "<file>": <parse error>`, or the file system's error for a
  missing file, so the module fails to import and the part is quarantined
  with `invalid_part`.
- `render` renders with no HTML escaping, through a per-call option that
  leaves mustache's global state unchanged; a missing name renders empty.
- `renderBlock` renders a template and removes one leading and one trailing
  newline. `renderSection(template, name, items)` renders only the first
  `#name` section with `items`, the same way; budgets are measured with it.
- The code supplies only data (which rows fit, cells already on one line,
  capped and pipe-escaped, locators, counts, fences, cut flags); the
  templates do all the formatting, each section tag alone on its line.

The names each template may cite: `system.md` the prompt variables;
`agent.md` `name` and `instructions`; the others the lists in
[`src/host/agents/catalog.ts`](src/host/agents/catalog.ts),
[`src/host/skills/catalog.ts`](src/host/skills/catalog.ts) and
[`src/host/skills/loaded.ts`](src/host/skills/loaded.ts).

## Tools

[`src/host/executor.ts`](src/host/executor.ts):

- The run offers every tool `tools/v1` lists for the prompt, in the order it
  lists them, each bound to the prompt's call. A listed tool not made with
  `defineTool` fails the run with `Tool "<name>" was not defined with
defineTool.`
- Before the model is called, every tool's settings are resolved from the
  configuration's `tools.<tool name>`: each declared field takes its stored
  value, or its default when no value is stored. A value that is empty or
  only whitespace, stored or default, is dropped; for a required field it
  refuses the prompt with `Tool <name> requires a <key> value.` Keys no
  declared field names are dropped.
  ([`src/host/tool-config.ts`](src/host/tool-config.ts)).
- A tool whose declared `resultModalities` the model does not all read is
  left out; a model whose catalog does not say keeps every tool.
- `load_skill` comes last. It is never registered with `tools/v1`, and it is
  left out of the definitions sent to the model until the run first lists a
  skill to load, and offered from then on.
- Each tool result is capped at the configuration's
  `execution.maxToolResultChars`, or `defaultMaxToolResultChars` (50,000)
  when it is absent; `load_skill` is exempt.

## Model

- Each run resolves the Thread's provider, model and effort once, with
  `resolveThreadExecution` of `runtime/contracts` on the configuration, and
  uses them for its agent loop, its input modalities, its
  `response.started` events and its automatic compaction. A Thread with a
  `providerId` runs on its own provider, model and effort; a Thread without
  one runs on the workspace default's provider, with its own model and effort
  over the default's when set ([`src/host/executor.ts`](src/host/executor.ts)).
- When that execution is unavailable, the run logs one warning `Thread
execution unavailable` with `{ threadId, providerId, model, issue }` and
  rejects before any model request with an `Error` whose `code` is
  `thread_execution_unavailable` and whose message is `The model "<model>" on
provider "<providerId>" is not available for this thread. Choose another
model in the conversation footer.`
- The language model comes from `models/v1.resolve` with the provider, the
  model and, when resolved, the effort; what it reads comes from
  `models/v1.inputModalities`.

## Attachments

When the session has `attachment`, the provider is wrapped
([`src/host/attachments.ts`](src/host/attachments.ts)). The history stays
text: an image is a Markdown image line in a user message or a tool result,
whose alt text is the image's name and whose target is
`doric-attachment:sha256-<64 hex>`. In each request, a user or tool message with string content that
holds such lines is rewritten:

- for a model that reads images (its input modalities include `image`, or
  the catalog does not say), each line whose attachment the Project holds
  becomes a text part ending in `[Image: <name>]` followed by an image part
  `data:<mediaType>;base64,<bytes>`; a line the Project does not hold stays
  text;
- for a model that reads no images, each line becomes
  `[Image: <name> (not shown: this model does not read images)]`, and nothing
  is read.

Each attachment is read once per run through `session.attachment`, however
many requests carry it: the read's promise is cached for the run. A read that
rejects makes the request that carries the line reject, and the rejection
stays cached, so every later request of that run carrying the line fails
too. The format of the line is defined in
[`bundles/runtime/runtime/src/contracts/attachments.ts`](../../runtime/runtime/src/contracts/attachments.ts).

## Skills

### What a run reads

At the start of each run, [`readRunSkills`](src/host/skills/sources.ts) reads
four lists in parallel:

- **Always-available skills**: the `skills/v1` skills registered with
  `alwaysAvailable: true`, in `skills/v1` order.
- **Built-in skills**: the other `skills/v1` skills, in `skills/v1` order. A
  failure of `skills/v1` rejects the run.
- **Workspace skills**: `<cwd>/.agents/skills/*/SKILL.md`, found with one
  `runtime.lease/v1` exec of `sh -c` with the directory as a positional
  argument, a 5,000 ms timeout, at most 64 files in sorted glob order and the
  first 4,096 bytes of each. A skill is named by its directory and described
  by its frontmatter's `description`; a file without one is skipped. A
  missing provider, a rejection, a non-zero or null exit code gives none.
- **Source skills**: every provider of `default.skill-sources/v1` except the
  one named `cwd`, in provider order, each asked in parallel with
  `list({ cwd })`. A source whose `list` takes more than 5,000 ms, rejects, or
  answers what fails the contract's schema offers nothing this time and is
  logged once per prompt through `log/v1` as `Skill source left out` with
  `{ bundleId, reason }`.

The frontmatter reader takes the top-level `<key>:` of a block opened by
`---` and closed by the next `---` line (or the end): plain values with
indented continuation lines joined by one space, single- or double-quoted
values, folded `>` and literal `|` blocks; an empty value counts as absent
([`src/host/skills/sources.ts`](src/host/skills/sources.ts)).

### The `# Skills` section

[`skillCatalog`](src/host/skills/catalog.ts) renders
[`skills-catalog.md`](src/host/prompts/skills-catalog.md):

- `## Always-available skills` holds each always-available skill's body
  verbatim under `### Skill: <name>`, in order, while the section stays within
  16,000 characters; the first one past that, and every one after it, become
  rows at the front of the built-in list.
- `## Skills to load` holds up to three tables, `### Built-in skills`,
  `### Workspace skills` and `### MCP server skills` (the source skills, with
  the text "Served by the Project's MCP servers." for every source), each
  only when its list is not empty. Each row is `| <locator> | <description> |`.
- A locator is the bundle skill's name, `cwd/<directory>` for a workspace
  skill, and `<bundle id>/<group>/<name>`, or `<bundle id>/<name>` without a
  group, for a source skill. A locator already taken in the run gets the first
  free `~2`, `~3`, ….
- Each cell is put on one line (whitespace runs become one space), pipes are
  escaped as `\|`, and descriptions are cut at 500 characters with `...`. The
  rows of a list must fit its budget — 8,000 characters for the built-in
  list, 4,000 for the workspace list and 4,000 for the source list —
  measured as the template renders them; past it, descriptions are cut at
  120 characters, then trailing rows are dropped while it still does, and a
  line says how many did not fit.
- The section is empty when no always-available skill fits and every list is
  empty.

The shown rows are the skills `load_skill` accepts.

### `load_skill`

[`src/host/skills/load-skill.ts`](src/host/skills/load-skill.ts): input
`{ name: string }`, strict; output a string. Its description is "Loads a
skill listed under \"Skills to load\" in your instructions or in a later
\"Skills changed\" message, and returns its instructions. Call it before
starting work that a listed skill's description matches."

- A name the run does not list now fails with `Unknown skill id "<name>".
Call load_skill with one of: \`a\`, \`b\`.`, or `Unknown skill id
  "<name>". No skill can be loaded now.` when none is listed; nothing is read.
- A listed skill is read again on every call: a bundle skill's body; a
  workspace skill through `runtime.lease/v1.readFile`, preceded by the line
  ``From the workspace: `<path>`. Paths in it are relative to `<dir>`.``; a
  source skill through that source's `read`, preceded by its `origin` when it
  gives one. The body is the text after the frontmatter, trimmed. A read that
  fails, a source that is gone or an answer that fails the schema fails the
  call with `The skill <name> could not be loaded: <cause>`.
- The answer is `# Skill: <name>`, the origin line when there is one, and the
  body, joined by blank lines and cut at 64,000 characters with `...`. When
  the history's most recent load of that locator is not cut and has the same
  text, the answer is `Skill <name> is already loaded above; follow it.`

### Mid-run changes

Before every model request after the first, [`liveCatalog`](src/host/skills/live.ts)
reads the working directory through `runtime.workspace/v1` (unknown or
failed: unchanged), scans `.agents/skills` again only when the directory
moved, and reads every source again with that directory; a source left out
keeps its last list and a source that is gone takes its skills with it.
Built-in and always-available skills are not compared.
[`skillCatalogChange`](src/host/skills/catalog.ts) then compares with the
last announced state:

- Added skills, workspace first, are rendered from
  [`skills-changed.md`](src/host/prompts/skills-changed.md) as tables fitted
  like the system prompt's (4,000 characters each). An added skill keeps the
  locator it had earlier in the run, or takes the next free one.
- The locators of shown rows whose skill went away are listed as skills that
  cannot be loaded now. A dropped row is never announced or reported.
- When there is something to say, the model reads one
  `<bundle-instruction bundle="default" reason="skills-changed">` message,
  stored in the history where it was read.

Checks never overlap and never reject. After an in-run compaction, the next
check compares with the system prompt's lists again, so a change the summary
replaced is told again.

## Agents

[`src/host/agents/definitions.ts`](src/host/agents/definitions.ts):

- **Format.** An agent is one Markdown file `<name>.md`, its name matching
  `agentNamePattern`, with a YAML frontmatter: `description` (required),
  `model` and `effort` (optional, `effort` one of `none`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`; blank counts as absent). `name:` and other
  keys are ignored. The text after the frontmatter, trimmed, is the
  instructions: a mustache template that may cite only the prompt variables
  (`os`, `date`, `timezone`, `user`, `user.name`); literal tags need a
  delimiter switch such as `{{=<% %>=}}`.
- **Invalid.** A file larger than 64,000 bytes, without a description, with
  an unknown effort, or whose instructions cite another name, hold a partial
  or do not parse. The reasons read `the file is larger than 64000 bytes`,
  `the frontmatter has no description`, `effort "<value>" is not one of none,
minimal, low, medium, high, xhigh, max`, `the instructions cite "<name>",
which is not a prompt variable (os, date, timezone, user, user.name); to
write literal mustache tags, switch delimiters with {{=<% %>=}}`, `the
instructions are not a valid template: <cause>`, and, for a workspace file
  `resolve` cannot read, `the file cannot be read`.
- **Built-in agents** ship as `src/host/agents/<name>.md`, listed
  in order in [`built-in.ts`](src/host/agents/built-in.ts) and read at
  import: `triage`, `search`, `spec`, `review`, `plan`, `contracts`,
  `tests`, `implementation`, `cleanup` and `docs`, the steps of the coding
  workflow. An invalid file, a file name outside the pattern or two files of
  one name make activation throw.
- **Workspace agents** are the `.agents/agents/*.md` files of the Thread's
  working directory, scanned with one `runtime.lease/v1` exec of `sh -c` with
  a 5,000 ms timeout: at most 64 regular files in sorted glob order, each with
  its size and its first 4,096 bytes. File names outside the pattern are
  ignored; an unreadable size counts as too large; the template is checked
  only when the head is the whole file. A missing provider, a rejection, a
  non-zero or null exit code gives none. A workspace file, valid or not,
  hides the built-in of its name; an invalid one is left out.
- **The `# Agents` section** ([`src/host/agents/catalog.ts`](src/host/agents/catalog.ts),
  [`agents.md`](src/host/prompts/agents.md)) holds one
  `| <name> | <description> |` row per agent in effect, descriptions cut at
  500 characters; trailing rows are dropped, and counted, while the rows pass
  8,000 characters, and at least one row always stays. No agent, no section.
- **Mid-run changes** ([`src/host/agents/live.ts`](src/host/agents/live.ts)):
  before every request after the first, the run reads the working directory
  and scans `.agents/agents` again only when it moved. When the agents changed
  by name, description or source, the model reads one
  `<bundle-instruction bundle="default" reason="agents-changed">` message
  from [`agents-changed.md`](src/host/prompts/agents-changed.md), before any
  "Skills changed" one: the added or changed agents as a table fitted like
  the section, and the names that went away. A change of `model` or `effort`
  alone is not told. After an in-run compaction, the next check compares with
  the system prompt's agents again.

## Input envelope

[`src/host/envelope.ts`](src/host/envelope.ts) wraps every input in the XML
envelope of its source, as `<tag attributes>`, a newline, the body, a newline
and `</tag>`:

| Source kind       | Envelope                                     |
| ----------------- | -------------------------------------------- |
| `user`            | `<user-request>`                             |
| `parent`          | `<parent-instruction thread="…" prompt="…">` |
| `terminal`        | `<terminal-output terminal="…" prompt="…">`  |
| `bundle`          | `<bundle-instruction bundle="…" reason="…">` |
| any other (child) | `<child-result thread="…" prompt="…">`       |

Attribute values escape `&`, `"` and `<`. In the body, a closing tag of any
of the five names, in any case, becomes `<\/…`; nothing else changes. The
bundle's own messages use `bundle="default"` with the reason
`skills-changed`, `agents-changed` or `loaded-skills`.

## Provider history

[`src/host/history.ts`](src/host/history.ts). The executor keeps a Thread's
history as the format `default.history/v1`, in two parts:

| Part       | Shape                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `messages` | The provider-ready messages of `llms` (`ProviderMessage[]`).                                                     |
| `meta`     | `{ checkpoints: Record<promptId, index>, messageCount: number, retained: Record<"<bundleId>:<reason>", index> }` |

`checkpoints` holds each prompt's turn boundary; `retained` holds the index of
each standing instruction, which compaction keeps verbatim. `formats()`
answers `default.history/v1` and `direct.history/v1`; a Thread stored as
`direct.history/v1` holds the same parts and is read as it is, and every save
writes `default.history/v1`. A missing `messages` part reads as none; a
missing `meta` reads as no boundary and no retained message, with
`messageCount` the length of `messages`; non-integer `retained` values are
dropped.

- `checkpoint({ history, promptId })` answers a patch of `meta` whose
  `checkpoints` gain `promptId` at the current `messageCount`; a boundary the
  prompt already has wins.
- `rewind({ history, promptId, removedPromptIds })` answers `undefined` when
  the prompt has no boundary; else a patch with the messages before the
  boundary, the boundaries of the removed prompts dropped, `messageCount`
  their length, and every retained index at or past the boundary dropped, so
  its instruction can be given again.
- A run saves `{ messages, meta }` with the event `response.finished`,
  `tool.finished` or `agent.steered`, and when it ends.

## Compaction

[`src/host/compact.ts`](src/host/compact.ts) and
[`src/host/compaction/`](src/host/compaction/compact.ts). Settings come from
the configuration's `execution.contextCompaction`, each field defaulting to
`defaultContextCompaction` of `host-config/contracts`
([Configuration](#configuration)).

**Automatic.** When `enabled`, a run measures pressure before its first
provider call (counting the enveloped input) and after every
`response.finished` ([`src/host/compaction/project.ts`](src/host/compaction/project.ts)):

- With a known context window, the projection is the last response's input
  tokens (else the history's characters / 4), plus its output tokens, plus
  the pending input's characters / 4; pressure exists when it reaches
  `pressurePercent`% of the window.
- Without a window, the history's characters / 4 plus the input's
  characters / 4 is compared with `pressurePercent`% of `charBudget`.
- A provider error, in an `error` event or thrown, forces one condensation
  per run without measuring when its `message`, `code` or `diagnostic`, or
  those of its `data`, match
  `/context( |_)(window|length|overflow)|too many tokens|maximum context|input tokens exceed|prompt is too long/i`
  (a space or an underscore after `context`, any case; the code writes the
  first group as a character class).

**Manual.** `compact` reads the configuration: `refused` / `disabled` when
compaction is disabled. It condenses with the `policy` the runtime passes
(`tailMinMessages`, `summaryMaxChars`), and summarizes with the Thread's
resolved provider and model, without effort; an unavailable execution or a
`models/v1` failure fails it as `summarizer_failed`.

**Planning** ([`src/host/compaction/compact.ts`](src/host/compaction/compact.ts),
[`boundaries.ts`](src/host/compaction/boundaries.ts)). The span `[0, end)`
ends at the largest safe boundary that keeps at least `tailMinMessages`
messages after it; a boundary is safe when no assistant tool call has its
request on one side and its result on the other, and the scan stops at a tool
result whose call is missing. An empty history is refused as
`missing_history`; no safe end above 0, or a span holding only earlier
summaries and retained messages, as `nothing_to_compact`. A refusal records
nothing.

**Summarizing** ([`src/host/compaction/summarize.ts`](src/host/compaction/summarize.ts)).
The run records `{ type: 'compaction.started', trigger }` (`automatic` or
`manual`). The span without its retained messages becomes a transcript of
`**User:**`, `**Assistant:**` (with `Tool calls: name(id), …`) and
`**Tool result for <id>:**` blocks separated by `---`; past
`summaryMaxChars × 8` characters only its tail is kept, after
`[... <n> characters of the oldest conversation omitted ...]`. The model
streams one answer with the transcript as the user message and a fixed
system prompt, `summaryPrompt`, which asks for a summary that replaces the
condensed part, written for an expert agent resuming with no other memory:
the overall task and its status; every decision, constraint and correction;
the file paths, branch names, commands and identifiers the remaining work
needs; every promise made or expected and every open question; the facts of
an earlier `[Context summary]` in the span merged in; small talk, failed
experiments and superseded content dropped; plain Markdown with short
sections; and no answer to, continuation of or question about the
conversation. An answer that is empty after trimming fails with
`The summarizer returned an empty summary.`, recorded as
`summarizer_failed`; an answer longer than `summaryMaxChars` is cut at its
last line break within the limit and ends with `[summary truncated]`.

**Rewrite** ([`src/host/compaction/rewrite.ts`](src/host/compaction/rewrite.ts),
[`markers.ts`](src/host/compaction/markers.ts)). The cut is checked again
(`unsafe_boundary` when it now splits a tool pair). The span is replaced by
one user message:

```text
[Context summary]
Condensed: <trigger> compaction replaced messages 0..<end> of this Thread's history with this summary.

<summary>
```

followed by the span's retained messages verbatim, in order, then the
"Loaded skills" message when there is one. The kept tail loses its
`thinking` and `redacted_thinking` replay items. Checkpoints inside the span
are dropped, later ones and retained indexes re-based. The history and
`{ type: 'compaction.finished', summaryId, summary, condensedMessages,
retainedMessages, tokensFreed, summaryChars }` are recorded together;
`summaryId` is `compaction-<uuid>` and `tokensFreed` an estimate (characters
/ 4 freed minus added). A run replaces its live messages and boundaries with
the rewrite and rechecks agents and skills against its system prompt.

**Failure.** A failure after `compaction.started` records
`{ type: 'compaction.failed', code, error }`, `code` being
`unsafe_boundary` or `summarizer_failed`; `compact` answers
`{ status: 'failed', code }`, and a run goes on with its history uncondensed.

**Loaded skills** ([`src/host/skills/loaded.ts`](src/host/skills/loaded.ts),
[`loaded-skills.md`](src/host/prompts/loaded-skills.md)). The skills loaded in
the span — successful `load_skill` results and the entries of an earlier
"Loaded skills" message — stay in effect through one retained
`<bundle-instruction bundle="default" reason="loaded-skills">` message under
the key `default:loaded-skills`, which a later compaction replaces rather
than keeps. It holds the most recent text of each locator not loaded again
in the kept tail, each in a fence longer than any backtick run in it, cut at
20,000 characters and marked as cut, within min(100,000, `charBudget` / 4)
characters; the `coding-workflow` entry comes first and is always kept, and
the locators that did not fit are listed. With nothing to keep, an earlier
message of that key is dropped.

## Writes

Every write goes through the run's session, wrapped by
[`coalesced`](src/host/deltas.ts): streamed deltas (`runtime/contracts`
`streamDelta`) are held and merged with `mergeDeltas` into one event per run
of same-kind deltas. A held run is written 250 ms after its first delta, when
its text reaches 64 KiB in UTF-8, before any other write, and when the run
ends; empty deltas are dropped. All writes go through one queue, so the log
keeps the run's order. A write's failure reaches its caller; a timed write's
failure reaches the next write, after a history save still runs. Held deltas
are never published, so a crash loses at most one unseen window.

## The `load_skill` block

The client part ([`src/client/`](src/client/index.ts)) defines
`default-skill-call` and registers it through `chat.views/v1` for the tool
`load_skill`, with `standalone: true`, so each call is a block of its own
outside the activity group. Without a chat it registers nothing.

- The chat sets the element's `view` (`ChatToolView`: `args`, `status`,
  `result`, `error`, `chosen`, `focused`)
  ([`src/client/skill-call.tsx`](src/client/skill-call.tsx)).
- The header shows `Loading skill`, `Loaded skill` or `Failed to load skill`
  by status, the skill's name in a monospace font, and `· <source>` muted.
  The name and source come from `args.name`, or the raw args when they are not
  a JSON object with a string `name`: `cwd/<x>` is `x` from `workspace`;
  `<a>/<b>/<x>` (without `/` in `a` or `b`) is `x` from `<a> · <b>`, so an MCP
  skill reads `mcp · <server>`; anything else is the whole locator from
  `built-in` ([`src/client/skill-load.ts`](src/client/skill-load.ts)).
- The body is the result as pre-wrapped text, or a compact error notice with
  the catalog `{ tool_failed: { title: 'Tool failed', retryable: false } }`,
  the fallback code `tool_failed` and the context `{ Tool: 'load_skill' }`.
- The block is folded while it loads and once loaded, and open when the load
  failed. The reader's choice is reported with the bubbling, composed event
  `chat-block-chosen` and `detail: { chosen }`; `toggle()` reports the
  opposite of what the block shows by that rule.

The client part imports only types from `chat/contracts` and builds the
`chat.views/v1` reference itself. It needs `desktop/ui/collapsible-block`,
hence `engines.doric` `^1.10.0`.

## The coding workflow

The skill `coding-workflow`
([`src/skills/coding-workflow/SKILL.md`](src/skills/coding-workflow/SKILL.md),
`order: 50`) coordinates a coding task in a Git repository through the ten
built-in agents. It is loaded on demand, and the executor does not offer it to
a Thread running as an agent ([`src/host/executor.ts`](src/host/executor.ts)).
The workflow itself is described in
[docs/features/coding-workflow.md](../../../docs/features/coding-workflow.md).

## Configuration

Everything comes from the configuration `host-config/v1` answers; the bundle
reads no environment variable.

| Key                                           | Default                                                               | Effect                                              |
| --------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| `profile.name`                                | absent                                                                | The `user.name` prompt variable.                    |
| `profile.timezone`                            | the host's zone                                                       | The zone of `date`.                                 |
| `execution.maxTurns`                          | required; `32` in the initial configuration                           | The agent's turn budget.                            |
| `execution.maxToolResultChars`                | `defaultMaxToolResultChars` (50,000)                                  | The cap of each tool result but `load_skill`'s.     |
| `execution.contextCompaction.enabled`         | `true`                                                                | Turns automatic and manual compaction on.           |
| `execution.contextCompaction.pressurePercent` | `80`                                                                  | The pressure line.                                  |
| `execution.contextCompaction.tailMinMessages` | `6`                                                                   | Messages an automatic condensation keeps.           |
| `execution.contextCompaction.summaryMaxChars` | `6000`                                                                | The automatic summary's length.                     |
| `execution.contextCompaction.charBudget`      | `200000`                                                              | The fallback budget and the "Loaded skills" budget. |
| `tools.<tool>.<key>`                          | the field's default when no value is stored; a blank value is dropped | A tool's settings.                                  |
| providers and default execution               | —                                                                     | Resolved by `resolveThreadExecution`.               |

The defaults of `maxToolResultChars` and `contextCompaction` are those of
[`bundles/foundation/host-config/src/contracts/index.ts`](../../foundation/host-config/src/contracts/index.ts);
the schema and the initial configuration, with `maxTurns`, are in
[`bundles/foundation/host-config/src/host/config/schema.ts`](../../foundation/host-config/src/host/config/schema.ts).

## Limits

| Limit                                               | Value                                         | Where                                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| OS probe, workspace scans, a source's `list`        | 5,000 ms                                      | [`variables.ts`](src/host/prompts/variables.ts), [`sources.ts`](src/host/skills/sources.ts), [`definitions.ts`](src/host/agents/definitions.ts) |
| Files per scan / bytes read per file                | 64 / 4,096                                    | [`sources.ts`](src/host/skills/sources.ts), [`definitions.ts`](src/host/agents/definitions.ts)                                                  |
| Always-available bodies                             | 16,000 chars                                  | [`catalog.ts`](src/host/skills/catalog.ts)                                                                                                      |
| Rows: built-in / workspace / source skills / agents | 8,000 / 4,000 / 4,000 / 8,000 chars           | [`skills/catalog.ts`](src/host/skills/catalog.ts), [`agents/catalog.ts`](src/host/agents/catalog.ts)                                            |
| Description cell                                    | 500, then 120 for skills                      | same                                                                                                                                            |
| `load_skill` answer                                 | 64,000 chars                                  | [`load-skill.ts`](src/host/skills/load-skill.ts)                                                                                                |
| Agent definition file                               | 64,000 bytes                                  | [`definitions.ts`](src/host/agents/definitions.ts)                                                                                              |
| "Loaded skills" entry / message                     | 20,000 / min(100,000, `charBudget` / 4) chars | [`loaded.ts`](src/host/skills/loaded.ts)                                                                                                        |
| Summarizer transcript                               | `summaryMaxChars` × 8 chars                   | [`summarize.ts`](src/host/compaction/summarize.ts)                                                                                              |
| Delta window / size                                 | 250 ms / 64 KiB                               | [`deltas.ts`](src/host/deltas.ts)                                                                                                               |
| `onBeforeModelRequestHook` handler deadline         | 10,000 ms                                     | [`hooks.ts`](../../foundation/core/src/shared/hooks.ts)                                                                                         |
| Forced condensations per run                        | 1                                             | [`executor.ts`](src/host/executor.ts)                                                                                                           |

## Errors and failure behavior

| Failure                                                        | Result                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Invalid built-in agent                                         | Activation throws; the bundle provides nothing.                                                 |
| Missing or invalid template                                    | The module fails to import; the part is quarantined with `invalid_part`.                        |
| Unavailable Thread execution                                   | Warning logged; `run` rejects with `code: 'thread_execution_unavailable'`.                      |
| Tool not made with `defineTool`, unmet tool setting            | `run` rejects before the model is called.                                                       |
| Invalid agent instructions on the Thread                       | `run` rejects before its first model request.                                                   |
| `tools/v1`, `skills/v1`, `host-config/v1` or `models/v1` fails | `run` rejects with that error.                                                                  |
| Unknown time zone                                              | `run` rejects with a `RangeError`.                                                              |
| Sandbox, workspace or a skill source cannot answer             | The list it would add is empty or kept; the run goes on.                                        |
| Generation process lost under a tool call                      | History saved as it stands; `run` rejects with the abort reason; the next run answers the call. |
| Context overflow                                               | One forced condensation; the run fails with the provider's error.                               |
| `session.attachment` rejects                                   | The request carrying that line rejects, and so does every later request of the run carrying it. |
| Compaction failure                                             | `compaction.failed` recorded; a run goes on, `compact` answers `failed`.                        |
| `load_skill` failure                                           | Only that tool call fails.                                                                      |
| `default.agents/v1` failure                                    | `ContractError` `invalid_input`, `not_found` or `invalid_definition`.                           |
| A write fails                                                  | The runtime's persistence error reaches the run.                                                |

## Build and test

The host loads `default` because its composition,
[`app/backend/doric-host/composition.json`](../../../app/backend/doric-host/composition.json),
lists it.

| Command                               | What it does                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx run bundle-default:build`     | Builds the dependencies, compiles `tsconfig.json` (host and contracts) to `dist/`, typechecks `tsconfig.client.json`, then runs the bundle build, which bundles the client part and copies skills and templates ([`project.json`](project.json)). |
| `npx nx run bundle-default:typecheck` | Typechecks the host, contracts, client, stories and `.storybook`.                                                                                                                                                                                 |
| `npx nx run bundle-default:test`      | Compiles `tests/` to `dist-tests/`, copies the host templates next to them, and runs `node --test` over `tests/*.test.js`, then `tests/client/*.test.js`.                                                                                         |

The host tests drive the executor against fake providers of `host-config/v1`,
`models/v1`, `tools/v1`, `skills/v1`, `hooks/v1`, `runtime.lease/v1`,
`runtime.workspace/v1` and `default.skill-sources/v1` and a fake prompt
session ([`tests/support/harness.ts`](tests/support/harness.ts)), and check
the exact request bodies of the real OpenRouter and OpenAI Responses
providers against [`tests/fixtures/request-body/`](tests/fixtures/request-body/system-prompt.md)
with a faked HTTP transport ([`tests/request-body.test.ts`](tests/request-body.test.ts)).
The client tests mount `default-skill-call` in a happy-dom document
([`tests/client/`](tests/client/skill-call.test.ts)). The story
[`stories/skill-call.stories.tsx`](stories/skill-call.stories.tsx) renders
the block for previews, wrapped by [`.storybook/preview.tsx`](.storybook/preview.tsx).

## Credits

The coding workflow (`src/skills/coding-workflow/SKILL.md`) and the `triage`,
`spec`, `review` and `docs` agents adapt the Elephant-Goldfish Model
(https://github.com/google/elephant-goldfish-model, commit 3d0b348),
Copyright 2026 Google LLC, Apache License 2.0.
