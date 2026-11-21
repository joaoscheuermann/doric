# default

Apply these rules to `bundles/runtime/default/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to the default agent: running one prompt of a Thread (its
system prompt, its tools, its model, its provider history and its
compaction), the skill catalog and `load_skill` of that run, the agents a
Thread can be spawned as, and the drawing of its own `load_skill` calls. Do
not add to it a tool other than `load_skill`, a skill source, a drawing of
another tool, or a Thread's storage: a tool belongs to the bundle that
registers it through `tools/v1`, a skill source to the bundle that provides
`default.skill-sources/v1`, and a Thread's storage to the runtime's
`PromptSession`.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it,
  and [docs/features/default-agent.md](../../../docs/features/default-agent.md)
  for the decisions it keeps.
- Put a feature in the file of its concern under `src/host/`: activation and
  every `services.provide` in `activate` of
  [`index.ts`](src/host/index.ts), and a new `executor/v1` method in its
  `createExecutor`; the run in [`executor.ts`](src/host/executor.ts); the
  history in [`history.ts`](src/host/history.ts); the input envelopes and
  `bundleInstruction` in [`envelope.ts`](src/host/envelope.ts); the images of
  attachments in [`attachments.ts`](src/host/attachments.ts); the coalescing
  of streamed deltas in [`deltas.ts`](src/host/deltas.ts); the resolution of
  tool settings in [`tool-config.ts`](src/host/tool-config.ts); compaction in
  [`compact.ts`](src/host/compact.ts) and `compaction/`; skills in `skills/`;
  agents in `agents/`; prompt variables and templates in `prompts/`. Put
  drawing only in `src/client/`.
- Write every new text the model receives whole as a Markdown template under
  `src/host/prompts/`, load it with `loadTemplate` at module load with the
  list of names it may cite, and supply only data from the code: never add
  model text formatted in TypeScript, and keep each mustache section tag
  alone on its line. Change the texts that stay in TypeScript where they
  are: the input envelopes of
  [`envelope.ts`](src/host/envelope.ts), the compaction texts of
  [`summarize.ts`](src/host/compaction/summarize.ts) and
  [`markers.ts`](src/host/compaction/markers.ts), and the short results and
  notes of [`executor.ts`](src/host/executor.ts),
  [`attachments.ts`](src/host/attachments.ts) and
  [`load-skill.ts`](src/host/skills/load-skill.ts).
- Measure the budget of a template section by rendering the section it fills
  with `renderSection`, never by counting characters in code. Change the
  character caps that cut text built or loaded in code in their own files:
  [`agents/catalog.ts`](src/host/agents/catalog.ts),
  [`skills/catalog.ts`](src/host/skills/catalog.ts),
  [`load-skill.ts`](src/host/skills/load-skill.ts),
  [`loaded.ts`](src/host/skills/loaded.ts) and the transcript factor of
  [`summarize.ts`](src/host/compaction/summarize.ts). Change the summary cap
  (`execution.contextCompaction.summaryMaxChars`) and the tool-result cap
  (`execution.maxToolResultChars`) only as settings of `host-config/v1`,
  never as constants of this bundle
  ([`compact.ts`](src/host/compact.ts), [`executor.ts`](src/host/executor.ts)).
- Keep a tool's description in its `defineTool`, never in a template.
- Keep the base system prompt the run builds at its start the same for the
  whole run; tell the model of a change during the run only as one
  `<bundle-instruction bundle="default">` message built with
  `bundleInstruction(reason, body)`. To announce a new kind of change, write
  a notifier beside [`skills/live.ts`](src/host/skills/live.ts) and
  [`agents/live.ts`](src/host/agents/live.ts) with the two members both have:
  `refresh()`, which never rejects and answers the message or `undefined`,
  and `rebase()`. Add its `refresh()` to the list `beforeRequest` awaits in
  [`executor.ts`](src/host/executor.ts), after the agents' and the skills'
  in that order, and call its `rebase()` where `executor.ts` calls theirs
  after a compaction that answers `compacted`.
- Put a message the compaction rewrite inserts, as it inserts "Loaded
  skills", into the rewrite as the `replace` of `applyCompaction`
  ([`compaction/compact.ts`](src/host/compaction/compact.ts)), a
  `RetainedReplacement`
  ([`compaction/rewrite.ts`](src/host/compaction/rewrite.ts)), and build it at
  both call sites in [`compact.ts`](src/host/compact.ts): `compactThread`
  (manual) and `maybeCompactRun` (in a run). The rewrite takes one
  replacement only, and "Loaded skills" holds it: a second inserted message
  needs `replace` to take a list first.
- Give a bundle message that must survive compaction a key
  `retainedKey('default', <reason>)` in `meta.retained`, and keep retained
  messages out of the summarizer's input.
- Add a prompt variable in
  [`src/host/prompts/variables.ts`](src/host/prompts/variables.ts): declare it
  in `PromptVariables` and `promptVariableNames`, compute it in
  `promptVariables` (or in `createRunVariables` when it is read from the
  sandbox), and cite it in [`system.md`](src/host/prompts/system.md). Agent
  instructions may cite only those names.
- Inside a run, write every history save and every event only through the
  coalesced session the run creates (`log` in
  [`executor.ts`](src/host/executor.ts)), never through the session it
  receives, so that held deltas are written first. Outside a run, as in
  `compactThread` of [`compact.ts`](src/host/compact.ts), write through the
  session the call receives.
- Run every `runtime.lease/v1` `exec` with a `timeoutMs`. `readFile` takes no
  timeout, and the runtime passes no signal to the sandbox for it: use it only
  for one file at a known path, under the run's `call`, which carries its
  Project scope ([`lease.ts`](../runtime/src/contracts/lease.ts),
  [`services/lease.ts`](../runtime/src/host/services/lease.ts)). Take the
  run's starting working directory from `thread.cwd`, and read a later one
  only through `currentCwd` of [`sources.ts`](src/host/skills/sources.ts),
  which asks `runtime.workspace/v1`. Never let a sandbox, a workspace or a
  skill source that cannot answer reject the run.
- Change the shape of `executor/v1` only in
  [`bundles/runtime/runtime/src/contracts/executor.ts`](../runtime/src/contracts/executor.ts),
  and `default.hooks/v1` and `default.agents/v1` only in
  [`src/contracts/index.ts`](src/contracts/index.ts). In the same change,
  raise the version of the `<id>@<version>` entry under `provides` of
  [`manifest.json`](manifest.json) and the manifest's `version` as
  [`bundles/AGENTS.md`](../../AGENTS.md) step 2 requires, and raise the range
  of each bundle that lists the contract under `requires` and uses the new
  member (`runtime` for `executor/v1`); a bundle that lists it under
  `optional` carries no range.
- Change `default.skill-sources/v1` only in
  [`src/contracts/index.ts`](src/contracts/index.ts), and keep it a bare id
  under `optional` here. In the same change, raise its version under
  `provides` of each provider's manifest, and this manifest's `version`, by
  the part of the change as [`bundles/AGENTS.md`](../../AGENTS.md) step 2
  states.
- Update [`tests/manifest.test.ts`](tests/manifest.test.ts) in the same change
  as every edit of [`manifest.json`](manifest.json): it pins the `version`,
  the `provides` entries and the `requires` ranges.
- Read every setting from the configuration `host-config/v1` answers, and add
  a new setting to host-config's contract
  (`bundles/foundation/host-config/src/contracts/index.ts`) and schema
  (`bundles/foundation/host-config/src/host/config/schema.ts`); never read an
  environment variable.
- Keep `direct.history/v1` in `formats()`, and keep every save writing
  `default.history/v1`: stored Threads hold both.
- Keep `chat.views/v1`, `runtime.lease/v1`, `runtime.workspace/v1` and
  `default.skill-sources/v1` under `optional`, so that the agent runs without
  them.
- In `src/client/`, import only types from `chat/contracts`, build the
  `chat.views/v1` reference with `ref`, and register the drawing inside
  `whenAvailable`.
- Add a built-in agent as `src/host/agents/<name>.md`. Start its
  instructions with the block every built-in agent shares, word for word
  (from `## Workflow step` up to its own heading), then `## <Name>` with the
  name's first letter capitalised. Add its name, in workflow order, to
  `BUILT_IN_AGENT_NAMES` in
  [`src/host/agents/built-in.ts`](src/host/agents/built-in.ts) and, with its
  description, to the `shipped` list of AG12 in
  [`tests/agents.test.ts`](tests/agents.test.ts). Route it in
  [`src/skills/coding-workflow/SKILL.md`](src/skills/coding-workflow/SKILL.md)
  and name it in that skill's description, which lists the workflow's
  agents. An invalid built-in file stops the bundle from activating.
- Never change the name of the skill `coding-workflow`, which
  `CODING_WORKFLOW_SKILL` in [`loaded.ts`](src/host/skills/loaded.ts) pins.
- Add a test of a pure function as `tests/<area>.test.ts` that calls it
  directly, and a test of a run, of a service or of `load_skill` as
  `tests/<area>.test.ts` driven by `bundleServices` and `runPrompt` of
  [`tests/support/harness.ts`](tests/support/harness.ts); add a test of the
  block under `tests/client/` with the helpers of `tests/client/support/`;
  put no test in another subfolder of `tests/`, since the `test` target runs
  only those two folders.
- When you change a template or the tools sent to the model, update the
  expected texts in [`tests/support/prompts.ts`](tests/support/prompts.ts) and
  the request-body fixtures in `tests/fixtures/request-body/` in the same
  change.
- Find this bundle's exceptions in
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  as the items of `violations` whose `bundle` is `default`, and read the
  `decision` document of each before changing the code it names.
- Among the feature docs you update, update
  [docs/features/default-agent.md](../../../docs/features/default-agent.md)
  with every change to the run, its contracts, its history or its limits,
  [docs/features/coding-workflow.md](../../../docs/features/coding-workflow.md)
  with every change to the `coding-workflow` skill or a built-in agent,
  [docs/features/skills.md](../../../docs/features/skills.md) with every change
  to how the run reads, lists or loads skills,
  [docs/features/context-compaction.md](../../../docs/features/context-compaction.md)
  with every change to how the executor condenses the history, and every
  other feature doc that `git grep -l 'bundles/runtime/default' docs/features`
  prints and that describes the changed code.

## Verify

- `npx nx run bundle-default:typecheck`: run it after any change under
  `src/`, `stories/` or `.storybook/`.
- `npx nx run bundle-default:test`: run it after any change under `src/` or
  `tests/`, or to `manifest.json`.
- `npx nx run bundle-default:build`: run it after any change under `src/`,
  or to `manifest.json`, `package.json` or a `tsconfig*.json` file.

## Generated files

None.
