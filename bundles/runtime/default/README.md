# Default bundle

`default` is the default agent: the agent loop behind every Doric
conversation. It was named `direct` until 2026-10-19. It runs one prompt
of a Thread: it builds the system prompt with the run's skills, offers the
model every registered tool and its own `load_skill`, calls the configured
model, saves the history as
it goes, and compacts a long conversation so the agent can keep working
within the model's context window.

It provides `executor/v1`, the default executor, and owns `default.hooks/v1` and `default.agents/v1`. The bundle runs in the
generation process next to `runtime`, which calls it. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

`executor/v1@1.3.0`, with:

- `run` — run one prompt of a Thread; from 1.3.0 the Thread it receives
  carries its agent with the agent's instructions, and its model and effort;
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

`default.agents/v1@1.0.0`, the agents a Thread can be spawned as (host-only:
no method is exposed to a window), with:

- `list` — the agents defined now, by name, description, source (`built-in`
  or `workspace`) and the optional `model` and `effort`, without instructions;
- `resolve({ name })` — one agent with its raw instructions, chosen by the
  same rule, or a `ContractError`: `invalid_input` (a name outside the
  pattern, or another key), `not_found` (naming the defined agents) or
  `invalid_definition` (the workspace file is invalid or cannot be read).

See **Agents** below.

## Behavior

- **System prompt:** the default instruction (`src/host/prompts/system.md`),
  ending with its `# Environment` section, followed, after a blank line, by the
  `# Agent: <name>` section of a Thread that runs as an agent (`agent.md`: the
  agent's instructions, rendered with the run's prompt variables), then the
  run's `# Agents` section, then its `# Skills` section, each when it has one;
  passed through
  `onBeforeModelRequestHook` before every model request.
- **Environment:** `system.md` renders the standard prompt variables
  (`src/host/prompts/variables.ts`), read once at the start of each run, so
  the prompt stays the same for the whole run:
  - `os`, the sandbox's operating system (`<PRETTY_NAME> (<uname -srm>)`),
    from one probe through the optional `runtime.lease/v1` (`uname -srm` and
    `/etc/os-release`, 5 s timeout), cached in memory per Project and lease id.
    A missing provider, a failed, timed-out or empty probe leaves the line out
    and is not cached, so the next run probes again;
  - `date`, today's calendar day (`YYYY-MM-DD`) in `timezone`: the host-config
    profile's `timezone`, else the host's zone. Never the time of day, so the
    prompt (which providers cache) changes at most once a day;
  - `user.name`, the profile's `name`; the line is left out without one (no
    git identity fallback).
- **Prompt templates:** every text the model receives whole is one Markdown
  file under `src/host/prompts`, rendered with `mustache`: `system.md`,
  `agent.md` (the `# Agent: <name>` section), `agents.md`
  (the `# Agents` section), `agents-changed.md`,
  `skills-catalog.md` (the `# Skills` section), `skills-changed.md` and
  `loaded-skills.md`. Tool descriptions, the
  `load_skill` one included, stay in the tool's `defineTool`. Each module reads the templates it uses once, when it
  loads, checks each against the names it may cite (`system.md` declares the
  prompt variables, the three message templates theirs; partials are refused) and renders it without HTML
  escaping. The code supplies only data (which skills and rows fit, cells on
  one line, capped and pipe-escaped, locators, dropped counts, fences, cut
  flags, omitted ids); the templates do all the formatting with mustache
  sections, each section tag alone on its line. `renderBlock` renders a
  template as a block, and `renderSection` renders one section for given
  items, which is how the budgets below are measured. A missing template
  fails the import, and the bundle is quarantined with `invalid_part`. The
  build copies the templates into `dist/host`, and `.prettierignore` leaves
  them alone so their bytes stay as written.
- **Skills:** read at the start of each prompt run, from four lists
  (`src/host/skills`, text in `src/host/prompts/skills-catalog.md`):
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

- **Agents:** the agents a Thread can be spawned as (`src/host/agents`, text
  in `src/host/prompts/agents.md`), served by `default.agents/v1` and listed
  in the system prompt's `# Agents` section. An agent is one Markdown file
  `<name>.md`, its name matching `^[a-z0-9][a-z0-9_-]{0,63}$`, with a YAML
  frontmatter holding `description` (required: when to use the agent),
  `model` and `effort` (optional, one of `none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`; blank counts as absent); `name:` and other keys are
  ignored. The text after the frontmatter, trimmed, is the agent's
  instructions: a raw mustache template that may cite only the prompt
  variables (`os`, `date`, `timezone`, `user`, `user.name`). To write literal
  mustache tags, switch delimiters first with `{{=<% %>=}}`.
  - Sources: the built-in agents ship with the bundle (`src/host/agents`:
    `triage`, `search`, `spec`, `review`, `plan`, `contracts`, `tests`,
    `implementation`, `cleanup` and `docs`, the steps of the coding workflow,
    each the same common block on its input, limits and tools followed by its
    step); the workspace agents are the `.agents/agents/*.md` files of the
    Thread's working directory. A workspace file replaces the built-in of its
    name, even when it is invalid. `list` gives the built-ins left, in
    shipped order, then the valid workspace agents in file-name order.
  - Invalid: a file larger than 64 000 bytes, without a description, with an
    unknown effort, or whose instructions cite another name or do not parse.
    The reasons read `the file is larger than 64000 bytes`,
    `the frontmatter has no description`,
    `effort "<value>" is not one of …`,
    `the instructions cite "<name>", which is not a prompt variable (…); to write literal mustache tags, switch delimiters with {{=<% %>=}}`,
    `the instructions are not a valid template: <mustache message>` (a
    partial tag gives `… includes partial "<name>"; partials are not supported`)
    and, for a workspace file `resolve` cannot read, `the file cannot be read`.
    An invalid workspace file is left out of
    `list`; `resolve` fails on it with `invalid_definition`. An invalid
    built-in file, a built-in file name outside the pattern or two built-in
    files of one name make activation throw, and the bundle provides nothing.
  - Reading: `list` scans `.agents/agents` with one `runtime.lease/v1` exec
    (at most 64 files, 5 s timeout), which prints each file's size and first
    4096 bytes; the template is checked only when that head is the whole
    file. `resolve` reads the whole file again and checks it all, so a file
    longer than 4096 bytes whose instructions cite another name is listed
    and then fails to resolve. No known working directory, a missing lease
    or a scan that fails gives the built-ins only.
  - Catalog: one `| Agent | Description |` row per agent, descriptions cut at
    500 characters, trailing rows dropped (and counted) while the rows pass
    8000 characters; at least one row always fits. No agent, no section.
  - Live: like the skills, before every model request after the first the
    run reads the working directory again (scanning `.agents/agents` only
    when it moved); when the agents changed by name, description or source,
    the model reads one `<bundle-instruction bundle="default"
reason="agents-changed">` message (`agents-changed.md`), before any "Skills
    changed" one: the added or changed agents as a table and the names no
    longer available. A `model` or `effort` change alone is not told. After
    an in-run compaction, the next check compares with the system prompt's
    agents again.

- **Working in code:** the instruction tells the agent to work at a
  repository's root, to initialize a repository for a complex deliverable that
  has none, and to ask the user first when the code is an experiment. It
  works on a repository only from its root, since the repository's own skills
  and agents are listed from the working directory. Before working on code it checks its directory with `cwd` and, at a
  repository root, loads the matching skills (see
  [docs/features/coding-workflow.md](../../../docs/features/coding-workflow.md)).
- **Coding in a repository:** the coding workflow is the built-in
  `coding-workflow` skill (`src/skills/coding-workflow/SKILL.md`), loaded on
  demand and not offered to Threads with `agent`: their instructions are their
  workflow. See
  [docs/features/coding-workflow.md](../../../docs/features/coding-workflow.md).

  The main Thread is the coordinator: it starts every task with triage, then
  chooses a small route (search when needed, plan, contracts, tests,
  implementation, cleanup, docs) or a large one (search, then a spec reviewed
  in four stages of fresh review lenses, with a user checkpoint after each and
  explicit approval, then plan through docs); an unclear idea goes through
  Brainstorm first (concept `proposed`, then `accepted`). Every route ends
  with docs and, on the large route or when docs changed files, a Docs-lens
  review. Each step is a built-in agent started with `agent: <name>`, the
  title `<Type>: <subject>` and its effort (triage, search, cleanup and docs
  `low`; plan, contracts, tests and implementation `medium`; spec and review
  `high`; no model, so agents inherit the coordinator's). A plain child given
  a `<parent-instruction>` does that step and skips the workflow; a trivial
  change skips the workflow, triage included.

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
  to load, and from then on. The `execution.maxToolResultChars` cap, or
  `defaultMaxToolResultChars` when it is absent, applies to every tool but
  `load_skill`, whose answer reaches the model whole.
  A prompt whose tool settings are unmet is refused before the model is called.
- **Model:** the configured execution provider, model and effort, read from
  `host-config/v1` and resolved through `models/v1`. A Thread's own model and
  effort, when it has them, replace the configured ones; the provider stays the
  configured one. The run's automatic compaction uses the run's model; manual
  compaction (`compact`) uses the configured execution model.
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
  `charBudget` / 4) characters, naming the ones that did not fit, except the
  `coding-workflow` entry, which is always kept
  ([docs/features/coding-workflow.md](../../../docs/features/coding-workflow.md)). After an
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
`host-config/v1`, `models/v1`, `tools/v1`, `skills/v1` and `hooks/v1`
providers and a fake prompt session, the skill catalog,
its mid-run changes, the agent definitions (the shipped built-in ones
included), their `# Agents` catalog and their mid-run changes, the loaded
skills kept across a compaction and
`load_skill` against fake `runtime.lease/v1`, `runtime.workspace/v1` and
`mcp/v1` providers that record every call (or none, to stand for an
unprovided one), and the `coding-workflow` skill's agent filter and pin. It also runs the exact request-body checks: the real `llms`
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

## Credits

The coding workflow (`src/skills/coding-workflow/SKILL.md`) and the `triage`,
`spec`, `review` and `docs` agents adapt the Elephant-Goldfish Model
(https://github.com/google/elephant-goldfish-model, commit 3d0b348),
Copyright 2026 Google LLC, Apache License 2.0.
