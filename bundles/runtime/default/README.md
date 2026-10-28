# Default bundle

`default` is the default agent: the agent loop behind every Doric
conversation. It was named `direct` until 2026-10-19. It runs one prompt
of a Thread: it builds the system prompt with the run's skills, offers the
model every registered tool and its own `load_skill`, calls the configured
model, saves the history as
it goes, and compacts a long conversation so the agent can keep working
within the model's context window.

It provides `executor/v1`, the default executor, and owns `default.hooks/v1`. The bundle runs in the
generation process next to `runtime`, which calls it. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

`executor/v1@1.2.0`, with:

- `run` — run one prompt of a Thread;
- `checkpoint` and `rewind` — give the runtime the history patch it commits;
- `formats` — the history formats it reads (`default.history/v1`, and
  `direct.history/v1` written before the rename);
- `compact` — condense an idle Thread's history on demand.

`default.hooks/v1@1.0.0`, an extension point for other bundles (the
`default` bundle registers no handler of its own), with:

- `onBeforeModelRequestHook` (`transform`, input `{ system }`) — runs before
  every model request of a prompt, under the prompt's call (`call.scope` names
  the prompt and `call.signal` aborts with it), so a handler can adjust the
  system prompt to the Thread's state at that turn. Each handler receives the
  previous one's output; a failing handler is skipped. A bundle registers
  through `hooks/v1` with `default.hooks/v1` in its `requires`:

  ```ts
  services
    .use(HooksV1)
    .use(DefaultHooksV1)
    .onBeforeModelRequestHook(({ system }) => ({
      system: `${system}\n\n# Project rules\n\nUse tabs.`,
    }));
  ```

## Behavior

- **System prompt:** the default instruction (`src/host/prompts/system.ts`)
  followed, after a blank line, by the run's `# Skills` section, when it has
  one; passed through `onBeforeModelRequestHook` before every model request.
- **Skills:** read at the start of each prompt run, from four lists
  (`src/host/skills`, prose in `src/host/prompts/skills.ts`):
  - the always-available bundle skills (`alwaysAvailable: true` in
    `skills/v1`), whose bodies the section holds verbatim, in `skills/v1` order
    (the global `order` key, then bundle order), up to 16 000 characters; the
    first one past that, and every one after it, moves to the front of the
    built-in list;
  - the built-in skills: the other `skills/v1` skills;
  - the workspace skills: `.agents/skills/*/SKILL.md` in the Thread's working
    directory, found with one `runtime.lease/v1` exec (at most 64 files, the
    first 4096 bytes of each) and described by their frontmatter's
    `description`;
  - the MCP server skills that the Project's connected servers list through
    `mcp/v1`.

  The last three are tables under "Skills to load": one row per skill, its
  locator and its description on one line. A locator is the bundle skill's
  `name`, `cwd/<directory>` for a workspace skill, or
  `mcp/<server slug>/<name>` for an MCP skill; one another skill already took
  gets `~2`, `~3`, …. The budgets are fixed: 8000 characters of rows for the
  built-in list and 4000 for each other one, with every description cut at
  500 characters, at 120 when a list passes its budget, and its trailing rows
  dropped (and counted) while it still does. The model loads a listed skill
  with `load_skill`, a tool the run adds last to its tools and never
  registers with `tools/v1`. Its `name` is a plain string: an id the run does
  not list now fails the call with `Unknown skill id "<name>"` and the ids it
  can load (or that none can be loaded), reading nothing. It answers the
  skill's instructions (up to 64 000 characters), reading a workspace skill
  through `runtime.lease/v1` and an MCP skill through `mcp/v1.readSkill` on
  every call; when the history already holds that exact text, uncut, it
  answers `Skill <id> is already loaded above; follow it.` instead. The
  workspace and MCP sources are best effort: a sandbox or server that cannot
  answer adds no skill, and a skill that cannot be read fails only that tool
  call.

  The system prompt stays the same for the whole run. Before every model
  request after the first, the run reads the Thread's working directory
  through the optional `runtime.workspace/v1` (scanning `.agents/skills` again
  only when it moved) and the MCP servers again; when the skills it can load
  changed, the model reads one `<bundle-instruction bundle="default"
reason="skills-changed">` message, stored in the history where it was read:
  the added skills as tables like the system prompt's, and the ids of listed
  skills that went away. An added skill keeps the id it had earlier in the run,
  or takes the next free `~N`; a row that did not fit is never announced or
  reported. A list that cannot be read, or a missing `runtime.workspace/v1`,
  changes nothing.

- **Working in code:** the instruction tells the agent to work at a
  repository's root, to initialize a repository for a complex deliverable that
  has none, and to ask the user first when the code is an experiment.
- **Coding in a repository:** the coding workflow
  (`src/host/prompts/repository.ts`) reaches the agent as a standing
  instruction, not as system prompt text, once per Thread. The bundle calls
  `runtime.threads/v1.instruct` (reason `coding-workflow`, `retain: true`):
  - when a task — the reader's request or a parent's delegated step — starts
    while the Thread's `cwdRepo` hint is set: the executor checks before the
    run's first model request;
  - when a running prompt moves into a repository root, after the tool batch
    that moved it: the `onThreadCwdChangedHook` handler checks the run;

  and in both cases only while the history the model reads does not hold it
  (`meta.retained`), so a later task, or a move between repositories, gives
  nothing again, and a rewind that removed it gives it once more.

  The workflow runs Search, Plan, Development (Contracts, then red Tests, then
  green Implementation) and Cleanup, each subagent type with its goal, tools,
  the files it may change, ordered steps, explicit rules and what it returns.
  Contracts generates the contracts as its result and changes no file; Tests
  derive expected values from the requirements, never from running code;
  Implementation never edits, weakens or special-cases a test and stops to
  report one that contradicts the plan; Cleanup deletes before it
  restructures and adds no abstraction. The main Thread delegates each
  step to a child Thread whose title and first instruction line name its type
  (`Search: …`, `Type: Search`), except for trivial changes; a child does its
  delegated step itself. Both runtime contracts are `optional`, because the
  runtime requires `executor/v1`.

- **Input envelope:** every input is framed in XML, not Markdown headers:
  `<user-request>`, `<parent-instruction thread="" prompt="">`,
  `<terminal-output terminal="" prompt="">`,
  `<child-result thread="" prompt="">` or
  `<bundle-instruction bundle="" reason="">`. Attribute values escape `&`, `"`
  and `<`; a closing tag of those five names inside the body becomes `<\/…`. Older
  history keeps its `# User request` text. The system prompt describes the
  envelope, the chat's `<comments>`, `<target>`, `<comment>` and `<message>`
  parts, and the `comment_reply` tool.
- **Tools:** every tool `tools/v1` lists, bound to the prompt's call, then
  the run's `load_skill` from the first request at which the run lists a skill
  to load, and from then on. The `execution.maxToolResultChars` cap applies to
  every tool but `load_skill`, whose answer reaches the model whole.
  A prompt whose tool settings are unmet is refused before the model is called.
- **Model:** the configured execution provider, model and effort, read from
  `host-config/v1` and resolved through `models/v1`.
- **History:** stored as `default.history/v1` in two parts, `messages` and
  `meta` (turn boundaries, message count, and `retained`: the index of each
  standing instruction by `<bundleId>:<reason>`, recorded when the run stores a
  retained bundle steer). A Thread written as
  `direct.history/v1` holds the same parts; it is read as is and rewritten in
  the new format on its next save. The executor saves it on
  `response.finished`, on `tool.finished` and when the run ends.
- **Checkpoint and rewind:** `checkpoint` and `rewind` give the runtime the
  history patch it commits.
- **Compaction:** when the configuration's `contextCompaction` section is
  enabled, a run measures context pressure before its first provider call
  and between turns, and condenses older history into one summary when it
  passes the configured line; `compact` does the same on demand. The rewrite
  keeps an assistant tool call with its result, and keeps every retained
  message of the condensed span verbatim right after the summary, out of the
  summarizer's input, with its index re-based like the turn boundaries; a
  rewind forgets the retained messages past its boundary. The skills loaded in
  the condensed span (and not loaded again in the kept tail) stay in effect
  through one retained `<bundle-instruction bundle="default"
reason="loaded-skills">` message after the summary (`default:loaded-skills`),
  which a later compaction replaces rather than keeps: the most recent text of
  each, cut at 20 000 characters and marked as cut, within min(100 000,
  `charBudget` / 4) characters, naming the ones that did not fit. After an
  in-run compaction, the next skills check compares with the system prompt's
  lists again, so a change the summary replaced is told again.
- **Writes:** every history and event write goes through the runtime's
  `PromptSession`, which redacts, persists, publishes and keeps the retry.
  Streamed deltas are coalesced first (`src/host/deltas.ts`, with the
  `runtime/contracts` `mergeDeltas` rule): one event per run of same-kind
  deltas, written after 250 ms, at 64 KiB, before any other write and when
  the run ends; empty deltas are dropped.

## Tests

`npx nx test bundle-default` runs the ported executor scenarios against fake
`host-config/v1`, `models/v1`, `tools/v1`, `skills/v1`, `hooks/v1` and
`runtime.threads/v1` providers and a fake prompt session, the skill catalog,
its mid-run changes, the loaded skills kept across a compaction and
`load_skill` against fake `runtime.lease/v1`, `runtime.workspace/v1` and
`mcp/v1` providers that record every call (or none, to stand for an
unprovided one), and the coding
workflow's instruction policy through the runtime hooks it observes. It also runs the exact request-body checks: the real `llms`
OpenRouter and OpenAI Responses providers, with a faked HTTP transport, must
send the bodies the stage-1 host recorded (`tests/fixtures/request-body`).

## Development

```console
npx nx build bundle-default
npx nx typecheck bundle-default
npx nx test bundle-default
```

The build writes `bundles/runtime/default/dist`. To rebuild and stage every
bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
