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
- Put a feature in the folder of its concern under `src/host/`: the run in
  `executor.ts`, the history in `history.ts`, compaction in `compact.ts` and
  `compaction/`, skills in `skills/`, agents in `agents/`, prompt variables
  and templates in `prompts/`; put drawing only in `src/client/`.
- Write every new text the model receives whole as a Markdown template under
  `src/host/prompts/`, load it with `loadTemplate` at module load with the
  list of names it may cite, and supply only data from the code: never add
  model text formatted in TypeScript, and keep each mustache section tag
  alone on its line. Change the texts that stay in TypeScript where they
  are: the compaction texts of `src/host/compaction/summarize.ts` and
  `src/host/compaction/markers.ts`, and the short results and notes of
  `src/host/executor.ts`, `src/host/attachments.ts` and
  `src/host/skills/load-skill.ts`.
- Measure the budget of a template section by rendering the section it fills
  with `renderSection`, never by counting characters in code. Change the
  character caps that cut text built or loaded in code in their own files:
  `src/host/compaction/summarize.ts`, `src/host/skills/load-skill.ts` and
  `src/host/skills/loaded.ts`.
- Keep a tool's description in its `defineTool`, never in a template.
- Keep the system prompt the same for the whole run: tell the model of a
  change during a run (as the "Agents changed" and "Skills changed" messages
  do) only as one `<bundle-instruction bundle="default">` message built with
  `bundleInstruction(reason, body)` and returned from the agent's
  `beforeRequest`; a message the compaction rewrite inserts, such as
  "Loaded skills", goes into the rewrite through `RetainedReplacement`.
- Give a bundle message that must survive compaction a key
  `retainedKey('default', <reason>)` in `meta.retained`, and keep retained
  messages out of the summarizer's input.
- Add a prompt variable only to `PromptVariables` and `promptVariableNames` in
  `src/host/prompts/variables.ts`; agent instructions may cite only those
  names.
- Write every history save and every event of a run only through the
  coalesced session the run creates (`log` in `executor.ts`), never through
  the session it receives, so that held deltas are written first.
- Read the sandbox only through `runtime.lease/v1` with a `timeoutMs`, and
  the working directory only through `runtime.workspace/v1`; never let a
  sandbox, a workspace or a skill source that cannot answer reject the run.
- Change the shape of `executor/v1` only in
  `bundles/runtime/runtime/src/contracts/executor.ts`, and in the same change
  raise `executor/v1@` under `provides` and the `version` of
  [`manifest.json`](manifest.json), and the `executor/v1` range under
  `requires` of `runtime`'s manifest when `runtime` uses the new member.
- Change `default.hooks/v1` and `default.agents/v1` only in
  `src/contracts/index.ts`, and in the same change raise their entry under
  `provides` and the `version` of [`manifest.json`](manifest.json), and the
  range of each bundle that requires them when it uses the new member.
- Change `default.skill-sources/v1` only in `src/contracts/index.ts`, keep it
  a bare id under `optional` here, and raise its version under `provides` of
  each provider's manifest in the same change.
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
- Add a built-in agent as `src/host/agents/<name>.md` and add its name, in
  workflow order, to `BUILT_IN_AGENT_NAMES` in `src/host/agents/built-in.ts`;
  an invalid built-in file stops the bundle from activating.
- Add a built-in skill as `src/skills/<name>/SKILL.md`; never change the name
  `coding-workflow`, which `CODING_WORKFLOW_SKILL` pins.
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
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "default"`.
- Update [`README.md`](README.md) and
  [docs/features/default-agent.md](../../../docs/features/default-agent.md)
  with every change to the run, its contracts, its history or its limits, and
  [docs/features/coding-workflow.md](../../../docs/features/coding-workflow.md)
  with every change to the `coding-workflow` skill or a built-in agent, in the
  same change.

## Verify

- `npx nx run bundle-default:typecheck`: run it after any change under
  `src/`, `stories/` or `.storybook/`.
- `npx nx run bundle-default:test`: run it after any change under `src/` or
  `tests/`.
- `npx nx run bundle-default:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file, `src/contracts/`,
  `src/client/`, `src/skills/` or a Markdown file under `src/host/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
