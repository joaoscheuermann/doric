# Agent Instructions

Every agent working in this repository must read this root `AGENTS.md` before
non-trivial planning, reviewing, artifact generation, architecture discussion,
code editing, or workflow execution. Before such work, also read the feature
docs (`docs/features/`) and the architecture documents (`docs/architecture/`)
of the area being changed, and use [`README.md`](README.md) as the overview of
the repository.

## Required Context

For non-trivial work, read only the context needed to act correctly, in this
order:

1. The feature docs (`docs/features/`) and the architecture documents
   (`docs/architecture/`) of the area being changed.
2. This root `AGENTS.md`.
3. Applicable nested `AGENTS.md` files, from broadest to most specific.
4. Matching `.agents/skills/*/SKILL.md` files.
5. Nearby source, tests, manifests, schemas, generated contracts, or artifacts.
6. If present, `.agents/bundles/project/index.md` as advisory generated
   repository context.

Use `rg` or the fastest available local search tool to find nested
instructions and relevant files. If a repository skill applies, load the
smallest useful set and state which skill instructions are being followed.

Treat `.agents/bundles/project/index.md` as generated context, never as an
authority source: use it only after this root `AGENTS.md`, the feature and
architecture docs, applicable agent instructions, and current source files, and
verify its claims against the real files before acting.

Use this authority order:

1. System and runtime safety instructions.
2. [Hard Constraints](#hard-constraints) in this root `AGENTS.md`.
3. Explicit user-approved constraints for the current task.
4. Current repository code, manifests, tests, and generated contracts.
5. Project agent instructions and task-specific skills.
6. The current task prompt.
7. [Convention Parameters](#convention-parameters) in this root `AGENTS.md`.
8. Agent preference or local judgment.

Treat Hard Constraints as gates: if a prompt conflicts with one, stop, cite the
HC ID, explain the conflict, and ask for user direction only when the
constraint allows a scoped human decision.

Treat Convention Parameters as defaults: follow them unless the task has a
clear reason to do otherwise, and record meaningful deviations where useful.

## Product Direction

Doric is a TypeScript-first agent-core project.

Current product work should focus on the agent runtime and its direct support
surfaces:

- prompt, message, and context handling;
- model/provider abstraction;
- tool definition, invocation, and result handling;
- agent loop control and structured events;
- error, cancellation, retry, and minimal state interfaces when justified.

The repository is not currently grounded in the former Rust CLI, daemon,
worker, lifecycle, TUI, slash-command, service, or multi-process architecture.
Those terms are out-of-scope markers unless the user explicitly expands the
product scope and current files support the change.

## Hard Constraints

### HC-001 Grounding Is Mandatory Context

Agents must read the root `AGENTS.md` before non-trivial planning, reviewing,
artifact generation, architecture discussion, code editing, or workflow
execution.

Enforcement: if the root `AGENTS.md` cannot be read, stop and report that the
root `AGENTS.md` cannot be satisfied.

### HC-002 Current Repository State Is Authoritative

Current code, manifests, tests, and generated contracts beat memory,
assumptions, stale documentation, older summaries, and generic model knowledge.

Enforcement: verify current files before making architecture claims or changing
architecture-relevant behavior. Mark uncertain or future behavior as uncertain.

### HC-003 Keep Scope To The TypeScript Agent

New product work belongs in the TypeScript agent core unless the user
explicitly expands the scope.

Enforcement: do not add or design CLI, daemon, worker, lifecycle service, TUI,
slash-command, Rust product packages, or multi-process behavior without
explicit user approval for that scope.

### HC-004 Respect Minimal Boundaries

Do not add package splits, host/runtime boundaries, provider coupling, tool
privileges, persistence layers, or process orchestration before they are needed
by the agent core.

Enforcement: inspect current manifests and source before changing package
layout, public APIs, provider composition, tool registration, event streaming,
session persistence, config schema, or runtime behavior.

### HC-005 Preserve Unrelated Worktree Changes

Do not revert, overwrite, delete, stage, or commit unrelated user, maintainer,
or sub-agent changes.

Enforcement: inspect status before edits and commits. Keep write scope small.
Use destructive recovery only with explicit user approval and verified target
paths.

### HC-006 Validate Before Claiming Completion

Do not claim code, docs, workflows, or generated artifacts are complete or
working without appropriate evidence.

Enforcement: run relevant checks or state clearly why they could not be run and
what risk remains.

### HC-007 Protect Sensitive And Boundary Surfaces

Do not weaken security, privacy, permission, sandbox, command-execution,
network, authentication, secret-storage, config, or session boundaries without
explicit approval and validation.

Enforcement: stop for review before expanding command execution, network
access, credential handling, repository mutation, or persisted config/session
behavior.

### HC-008 Generated, Vendored, Lock, And Build Artifacts Need Provenance

Do not casually hand-edit generated contracts, vendored code, lockfiles,
schemas, or build outputs.

Enforcement: use the repository-approved generation, formatting, or validation
path when one exists, and explain why the artifact changed.

### HC-009 Human Gates Must Be Explicit

When scope, product tradeoffs, safety exceptions, destructive actions, missing
approval, or validation substitutions require human judgment, ask the user and
record the answer where useful.

Enforcement: do not treat silence, model confidence, or relative ranking as
user approval.

### HC-010 Keep Completion And Stream Inputs Human-Readable

Newly written or materially revised user-message inputs passed to model
`complete` or `stream` calls must not use raw or serialized JSON objects or
arrays as their outer prompt envelope.

Enforcement: write the outer prompt as simple, direct, unambiguous,
evidence-grounded Markdown. Approved exception: the default agent's input
envelope (`<user-request>`, `<parent-instruction>`, `<child-result>`,
`<terminal-output>`, `<bundle-instruction>`) and the chat's prompt structure (`<comments>`, `<target>`,
`<comment>`, `<message>`) use those XML tags, with readable text or Markdown
inside; system prompts and every other model input stay Markdown. Literal JSON
source material is allowed only in a
labeled fenced `json` block within that Markdown. This constraint does not
apply to provider transports, JSON-RPC, configuration, storage or persistence,
tools or tool payloads, schemas, or other non-prompt JSON.

## Convention Parameters

| ID     | Convention                                     | Default                                                                     | Deviation rule                                                            |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CP-001 | Prefer the agent-only direction.               | Keep product work focused on the TypeScript agent core.                     | Explain why the task needs a larger product surface.                      |
| CP-002 | Prefer narrow, evidence-backed changes.        | Edit only files needed for the task and validate the touched behavior.      | Explain why a broader change is required.                                 |
| CP-003 | Prefer TypeScript and Nx-native commands.      | Use configured TypeScript, Nx, and formatter commands before substitutes.   | Explain tool absence, sandbox limits, or why a fallback proves the claim. |
| CP-004 | Prefer small interfaces over early frameworks. | Add minimal TypeScript contracts that can be tested directly.               | Explain why a larger abstraction is justified now.                        |
| CP-005 | Prefer progressive discovery.                  | Read only the root `AGENTS.md`, instructions, manifests, and source needed. | Broaden search when the task crosses boundaries or evidence is missing.   |
| CP-006 | Prefer durable provenance.                     | Name changed files, validation commands, decisions, and generated outputs.  | Explain why provenance cannot be recorded.                                |
| CP-007 | Prefer implementation over chat-only advice.   | Land requested repository deliverables in files and verify them.            | Explain any blocker that prevents file changes.                           |
| CP-008 | Prefer Nx-managed package boundaries.          | Use Nx-visible workspace packages and public package entrypoints.           | Explain why a folder, manual scaffold, or direct source import is safer.  |
| CP-009 | Author model prompts for people first.         | Use simple, direct, unambiguous, evidence-grounded Markdown.                | Explain why another prompt format is necessary.                           |

## Working Rules

- Inspect the real local files before making architecture or implementation
  claims.
- Keep edits scoped to the request and the relevant ownership boundary.
- Preserve unrelated dirty worktree changes.
- Prefer existing package patterns, helper APIs, and tests before adding new
  abstractions.
- Use `apply_patch` for manual file edits.
- Write all documentation in English: feature and architecture docs, specs,
  decision records, READMEs and `AGENTS.md` files.
- Do not use destructive commands, broad rewrites, or rollback operations
  unless the user explicitly approves them.
- Update the feature doc (`docs/features/`), the README and the architecture
  document (`docs/architecture/`) that a change touches, in the same change.

## Runtime Boundaries

- Keep the agent runtime an embeddable TypeScript agent core, usable from tests
  and from host surfaces, without coupling the agent to a specific CLI, daemon,
  worker, UI, provider, or process model.
- Keep provider integration behind TypeScript interfaces. Do not make one
  provider the only runtime path unless the task is intentionally a narrow
  first slice.
- Keep tool behavior behind explicit, typed, testable interfaces. Do not add
  host command execution, network access, filesystem mutation, credential
  handling, persistence, or session behavior without explicit scope and
  validation.
- Never print, log or commit a credential or secret, and never persist one
  outside the host's credential store: the `credential` table of the
  `postgres` bundle, reached only through `secrets/v1`, which keeps each secret
  as an AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY`, redacts it from
  events and logs, and keeps it out of tool payloads
  ([`docs/features/credentials.md`](docs/features/credentials.md)).
- Prefer dependency injection and explicit configuration objects for sensitive
  runtime inputs.

## Testing

Before any test-specific work (planning, writing, changing, reviewing,
diagnosing, evaluating or running tests), load and follow
`.agents/skills/behavioral-testing/SKILL.md`, together with applicable
repository and language conventions.

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
- Apply the exception and the scope of
  [HC-010](#hc-010-keep-completion-and-stream-inputs-human-readable) to XML tags
  and non-prompt JSON.

## Nx And Packages

- Keep every workspace package inside one of the npm workspace globs of the
  root `package.json` (`bundles/*/*`, `packages/*`, `tools/*`, `workflows/*`,
  `benchmarks/*`, `app/*/*`), so that Nx manages it.
- Keep these placements:
  - product packages under `packages/*`; do not add root-level product
    packages;
  - bundles under `bundles/<group>/<id>/`, following
    [`bundles/AGENTS.md`](bundles/AGENTS.md);
  - the backend host and its end-to-end tests under `app/backend/*`;
  - the desktop applications, renderer, platform, and end-to-end tests under
    `app/desktop/*`;
  - standalone tool packages under `tools/*`;
  - workflow packages under `workflows/*`;
  - private evaluation instruments under `benchmarks/*`.
- Before adding a package or boundary, identify the responsibility that makes
  it deeper than a folder: a stable public contract, separate test boundary,
  dependency-direction boundary, or proven second consumer.
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

After every file-editing task, format changed code with
`npx biome format --write <files>` and changed supported files Biome cannot
format with `npx prettier --write <files>`, then always
run `npm run format:check` and `npm run lint` before the final response.
After a change to a manifest, a `package.json` or an import between bundles,
also run `npm run lint:test`; tolerated violations are in
`tests/boundary-exceptions.json`.
Fix violations introduced by the task and rerun the checks after corrections.
Do not run workspace-wide autofixes or reformat unrelated files unless asked.
If existing violations or tooling failures prevent a clean result, report
them explicitly; do not silently skip checks or claim they passed.

Use the narrowest reliable proof for the change. Prefer configured Nx targets
for TypeScript work, repository formatter checks for formatting work, and
`git diff --check` for docs-only changes.

Do not claim completion without validation evidence. If validation is blocked,
state the blocker and residual risk.

Name the changed files, summarize the change, and report validation in every
final response; keep it concise.
