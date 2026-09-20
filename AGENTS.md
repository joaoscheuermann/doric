# Agent Instructions

`GROUNDING.md` is the repository validity contract. Read it before
non-trivial planning, reviewing, artifact generation, architecture discussion,
code editing, or workflow execution.

If `GROUNDING.md` cannot be read, stop and report that the repository
grounding contract cannot be satisfied.

## Required Context

For non-trivial work, read only the context needed to act correctly, in this
order:

1. `GROUNDING.md`.
2. This root `AGENTS.md`.
3. Applicable nested `AGENTS.md` files, from broadest to most specific.
4. Matching `.agents/skills/*/SKILL.md` files.
5. Nearby source, tests, manifests, schemas, generated contracts, or artifacts.
6. If present, `.agents/bundles/project/index.md` as advisory generated
   repository context.

Use `rg` or the fastest available local search tool to find nested
instructions and relevant files. If a repository skill applies, load the
smallest useful set and state which skill instructions are being followed.

`.agents/bundles/project/index.md` is generated context, not an authority
source. Use it only after the grounding contract, applicable agent
instructions, and current source files; verify generated claims against the
real files before acting.

## Working Rules

- Inspect the real local files before making architecture or implementation
  claims.
- Keep edits scoped to the request and the relevant ownership boundary.
- Preserve unrelated dirty worktree changes.
- Prefer existing package patterns, helper APIs, and tests before adding new
  abstractions.
- Use `apply_patch` for manual file edits.
- Do not use destructive commands, broad rewrites, or rollback operations
  unless the user explicitly approves them.
- Use `GROUNDING.md` for hard constraints, scope gates, and architecture
  validity.
- Update `GROUNDING.md` when the task intentionally changes product scope,
  package responsibilities, dependency direction, provider composition,
  built-in tools, event streaming, user-input handling, session persistence,
  config schema, runtime behavior, or vendored dependency strategy.

## Testing

For every task whose scope includes tests, load and follow
`.agents/skills/behavioral-testing/SKILL.md` before test-specific work. This
includes planning, writing, changing, reviewing, diagnosing, evaluating, or
running tests. Apply it together with applicable repository and language
conventions.

## Prompt Authoring

Use `.agents/skills/write-agent-prompts/SKILL.md` when writing or materially
revising model-facing prompts.

- Write system prompts and user-message inputs passed to model `complete` or
  `stream` calls for human readers first, using simple, direct, unambiguous,
  evidence-grounded Markdown.
- Do not serialize instructions or context as a JSON object or array and use
  that serialization as the outer `complete` or `stream` user message. Literal
  JSON evidence may appear only in a labeled fenced `json` block inside an
  otherwise readable Markdown prompt.
- Use structural Markdown such as headings, lists, tables, and labeled fences
  when it improves comprehension. Avoid decorative formatting.
- Request Markdown or text output by default. Reserve JSON output for results
  that are genuinely machine-structured, and prefer the runtime's schema and
  validation mechanism over prompt-only JSON instructions.
- These prompt rules do not govern provider transport JSON, JSON-RPC,
  configuration, storage or persistence, tools or tool payloads, schemas, or
  other non-prompt JSON.

## Nx And Packages

- Product packages belong under `packages/*`; do not add root-level product
  packages.
- Use current manifests and source as the package inventory.
- Create TypeScript packages with the `@nx/js` generator when available.
- Export package APIs through `src/index.ts`.
- Consume sibling packages by public package entrypoint, not private source
  paths or `../` imports.
- Declare workspace package dependencies in consuming package metadata when
  metadata exists.
- Run `npx nx sync` when TypeScript project references need reconciliation.
- Validate package changes with `npx nx show projects` plus affected
  `typecheck`, `test`, or `build` targets.

## Validation And Response

After every file-editing task, format the changed files with
`npx prettier --write <files>` (for supported, non-ignored files), then always
run `npm run format:check` and `npm run lint` before the final response.
Fix violations introduced by the task and rerun the checks after corrections.
Do not run workspace-wide autofixes or reformat unrelated files unless asked.
If existing violations or tooling failures prevent a clean result, report
them explicitly; do not silently skip checks or claim they passed.

Use the narrowest reliable proof for the change. Prefer configured Nx targets
for TypeScript work, repository formatter checks for formatting work, and
`git diff --check` for docs-only changes.

Do not claim completion without validation evidence. If validation is blocked,
state the blocker and residual risk.

Final responses should name changed files, summarize the change, and report
validation. Keep them concise.
