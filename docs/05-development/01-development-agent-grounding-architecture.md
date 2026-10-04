# Development Agent Grounding Architecture

This document defines Doric Step 05 Development. It is internal,
self-contained guidance for implementing validated effort files through fresh
specialized agents, strict effort ordering, red-green evidence, review, and
commit checkpoints.

Development intentionally uses less candidate search than PRD, TDD, or
Decomposition. Once the user approves decomposition, the safest baseline is a
linear, transactional loop: localize, write failing tests, implement the minimal
patch, validate, review, commit, then advance one effort.

## Purpose

Step 05 answers one question for the current effort:

```text
Can this exact effort be proven complete, reviewed, and committed without
touching unrelated work or skipping Doric gates?
```

Step 05 must not decide:

- Which effort to run out of numeric order.
- Whether development may begin without `decomposition_to_implementation`
  approval.
- Whether an effort may be marked done without red evidence, green evidence,
  reviewer approval, accepted required-agent rows, and a commit checkpoint.
- Whether unrelated dirty worktree changes may be staged, reverted, or
  overwritten.
- Whether a later effort may start while the current effort is blocked.

Development is not a tournament phase. Repair agents are spawned only for
concrete validator or reviewer findings, and only inside the active effort's
ownership scope.

## Non-Negotiable Rules

- Do not begin unless the workflow state harness has approved
  `decomposition_to_implementation` and the generated `<run>/STATE.md`
  projection shows that approval for audit.
- Do not begin if the `Effort order` table is empty or if `Next effort index`
  does not point to the earliest unfinished effort.
- Process efforts strictly in numeric filename order.
- Run one effort at a time. No later effort may start while an earlier effort
  is `todo`, `in-progress`, missing validation evidence, missing reviewer
  approval, missing a commit checkpoint, or holding active locks.
- Before spawning development agents, request one atomic harness transition
  from `todo` to `in-progress`, update the effort file status, and project
  active locks into `STATE.md`.
- Record red evidence before implementation unless the effort is explicitly
  validation-only and the validation record explains the exception.
- Record green evidence before review.
- Require accepted required-agent rows for test planner, test writer, code
  writer, validator/refactor, and reviewer before marking an effort done.
- Create exactly one scoped conventional commit checkpoint for each completed
  effort before asking the harness to advance `Next effort index`.
- Stage only effort-owned files and required Doric artifacts. Preserve
  unrelated dirty worktree changes.

## Workflow State Authority

In the target architecture, the workflow state harness owns canonical
development transitions: approval checks, active effort selection, effort
status moves, lock state, validation and receipt state, commit checkpoint
recording, and `Next effort index` advancement.

The Development Supervisor coordinates evidence and worker execution, but it
does not make manual edits to `STATE.md` the source of truth. `STATE.md` is the
harness-generated human-readable projection and audit ledger that agents and
humans read before acting.

## Grounding Model

Hard constraints include effort order, active locks, worktree safety,
sub-agent proof, red/green validation, reviewer approval, commit checkpoints,
package ownership, dependency direction, generated-artifact provenance, and
security or permission boundaries.

Convention parameters include preferred test commands, focused patch size,
refactor restraint, existing helper APIs, naming, and language-specific coding
standards.

When inputs conflict, apply this authority order:

1. System and runtime safety requirements.
2. Doric workflow gates and repository-level grounding.
3. User-approved hard constraints for the current run.
4. Workflow state harness current effort, effort order, approvals, active
   locks, and validation records, as projected into `<run>/STATE.md`.
5. The active effort file.
6. Accepted `PRD.md`, `TDD.md`, and `FEATURES.md`.
7. Current repository source, manifests, schemas, generated contracts, tests,
   and architecture documents.
8. `.agents/skills/coding-conventions/SKILL.md` and applicable references.
9. Convention parameters and local judgment.

The active effort file constrains the patch, but it cannot override
repository-level hard constraints or current source truth.

## Inputs

| Input              | Path                                                         | Purpose                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State projection   | `<run>/STATE.md`                                             | Displays harness-generated approval, current effort, next legal effort, active locks, required-agent rows, validation records, and commit checkpoints for audit and review. |
| Effort file        | `<run>/efforts/NN_<name>.md`                                 | Defines goal, target files, coupled files, ownership, tests, regression suites, and acceptance criteria for the active effort.                                              |
| Feature map        | `<run>/FEATURES.md`                                          | Provides requirement and technical coverage back to accepted PRD/TDD scope.                                                                                                 |
| Accepted PRD/TDD   | `<run>/PRD.md`, `<run>/TDD.md`, or resolved promoted paths   | Provides product and technical source of truth when effort scope or acceptance is unclear.                                                                                  |
| Grounding          | `GROUNDING.md`, `AGENTS.md`, `.agents/skills/doric/SKILL.md` | Defines hard gates, worktree policy, package responsibilities, and proof expectations.                                                                                      |
| Coding conventions | `.agents/skills/coding-conventions/SKILL.md`                 | Defines repository implementation and testing standards for development workers.                                                                                            |
| Repo evidence      | Current source, tests, manifests, schemas, docs              | Anchors localization, test placement, implementation, validation, and review in real files.                                                                                 |

Every development worker that touches or approves tests or implementation must
load `.agents/skills/coding-conventions/SKILL.md`, then read only the
language/task-specific references needed for the active effort.

## Development Supervisor

The Development Supervisor owns one active effort at a time as an
orchestrator. It coordinates transition requests, sub-agent delegation, locks,
validation records, review, and commit checkpoints through the workflow state
harness.

Responsibilities:

- Inspect the harness-generated `STATE.md` projection, active locks, effort
  statuses, validation records, and worktree status before choosing the next
  action.
- Resolve the only legal effort from `Next effort index`.
- Keep the effort file status aligned with harness state and the generated
  `STATE.md` row status.
- Register required-agent rows before spawning each development role.
- Give every worker explicit read scope, write scope, validation expectation,
  output path, and stop condition.
- Ensure code-edit workers know they are not alone in the codebase and must not
  revert edits made by others.
- Record red and green evidence under `<run>/validation/`.
- Spawn repair writers only for concrete validator or reviewer findings.
- Stage only approved effort-owned files and required Doric artifacts.
- Commit the completed effort before asking the harness to advance to the next
  effort.
- Stop at the current effort when validation, review, ownership, staging, or
  commit fails.

The Supervisor may summarize findings and submit transition facts to the
harness, but required agent roles count only when spawn-backed rows and
accepted receipts exist in canonical state and the generated `STATE.md`
projection.

## Agent Set

| Role               | Agent type         | Purpose                                                                                                          | Write scope                                                             |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| test planner       | worker             | Translate effort acceptance criteria into concrete focused and regression commands.                              | Usually validation notes or response only.                              |
| test writer        | worker             | Add or update tests, then capture expected failing output before implementation.                                 | Test files only.                                                        |
| code writer        | worker             | Implement the minimal patch that satisfies the active effort and recorded failing tests.                         | Implementation files listed by effort ownership.                        |
| validator/refactor | worker             | Run focused and regression checks, apply narrow refactors only when within ownership, and record green evidence. | Validation record and scoped code/test files when refactor is approved. |
| reviewer           | explorer or worker | Review diff against effort scope, grounding, coding conventions, tests, validation, and state proof.             | Read-only unless writing a review artifact.                             |
| repair writer      | worker, optional   | Fix concrete validator or reviewer findings inside the active effort.                                            | Narrow files named by the finding and active locks.                     |

Repair writers are fresh bounded agents. They do not replace validator or
reviewer roles, and their output must be validated and reviewed before the
effort can finish.

## Linear Flow

```text
Supervisor reads harness state projection, effort order, locks, validation records, worktree
  |
  v
Resolve effort where Index == Next effort index
  |
  v
Harness records todo -> in-progress transition and active locks
  |
  v
Test planner localizes acceptance criteria to commands
  |
  v
Test writer creates failing tests and captures red evidence
  |
  v
Code writer implements minimal patch
  |
  v
Validator/refactor runs focused and regression checks and records green evidence
  |
  +-- concrete failure: spawn bounded repair writer, then revalidate
  |
  v
Reviewer checks scope, evidence, state, coding conventions, and diff
  |
  +-- concrete review finding: spawn bounded repair writer, then revalidate and review
  |
  v
Harness records in-progress -> done transition after scoped staging and commit
  |
  v
Release locks, increment Next effort index, resolve next effort
```

This flow mirrors a simple localization, repair, and validation pipeline inside
Doric's harness-managed state model. The Supervisor keeps the loop
transactional so a failed effort leaves evidence and locks visible instead of
drifting into later work.

## State Gate

Before starting an effort, the Supervisor checks:

- Harness state approves `decomposition_to_implementation`, and generated
  `STATE.md` projects that approval.
- The generated `Effort order` is non-empty.
- `Next effort index` in harness state and generated `STATE.md` points to the
  earliest effort not already `done`.
- No other effort is `in-progress`.
- Every earlier effort is `done`, has green evidence, reviewer approval, a
  commit checkpoint, and no active locks.
- The target effort file status matches harness state and the generated
  `STATE.md` row status.
- The target effort status is `todo`.
- The current worktree status is inspected and unrelated dirty changes are
  identified.

If any check fails, development stops and records the blocker. It does not pick
a different effort.

## Red Evidence

Red evidence proves that the new or updated tests fail for the expected reason
before implementation.

The validation record should include:

- Test command.
- Exit code.
- Failure summary.
- Assertion or behavior that maps to effort acceptance criteria.
- Test files changed.
- Any unavailable tooling.

If an effort is validation-only, migration-only, or documentation-only and red
evidence is not meaningful, the test planner must justify the exception before
implementation-like work begins. The validation record must name the substitute
baseline evidence.

## Implementation Rules

The code writer receives:

- Active effort path.
- Current `STATE.md` cursor and locks.
- Red evidence path.
- Target files and write ownership.
- Coupled read-only files.
- Focused command expected to pass.
- Coding-conventions skill path.

The code writer must:

- Load and follow coding conventions before editing.
- Keep edits within active write scope.
- Prefer existing helpers, APIs, and package patterns.
- Avoid unrelated refactors.
- Stop instead of widening scope when the effort file is wrong or incomplete.
- Report changed paths and any extra read-only context used.

Implementation should be the smallest patch that makes the active effort's
tests pass while preserving package ownership and dependency direction.

## Green Evidence

Green evidence proves the effort works after implementation and refactor.

The validation record should include:

- Focused commands and exit codes.
- Regression commands and exit codes.
- Output summaries.
- Refactors applied.
- Unavailable tooling or skipped checks with reasons.
- Residual risk.

Green evidence must exist before review. A reviewer may request additional
focused or regression checks when the diff, effort file, or coupled files show a
gap.

## Review Gate

The reviewer checks:

- The active effort is the one named by harness state and projected as
  `Current effort` in `STATE.md`.
- Effort status, harness state, and generated `STATE.md` status agree.
- Required development roles have accepted spawn-backed rows.
- Test and code workers loaded applicable coding-conventions references.
- Red evidence was captured before implementation or has a justified
  exception.
- Green evidence covers focused and regression commands from the effort file.
- The diff is scoped to active ownership and required Doric artifacts.
- No unrelated dirty work was reverted, overwritten, staged, or committed.
- Package ownership, dependency direction, generated-artifact provenance, and
  security boundaries remain valid.
- The validation record, active locks, changed files, and effort ownership
  agree.

The reviewer can approve, request concrete repair, or block. A request for
repair must name exact findings and files. The Supervisor spawns a fresh repair
writer for accepted repair findings, then reruns validation and review.

## Commit Checkpoint

Each completed effort requires one conventional commit before the next effort
starts.

Before committing:

1. Inspect `git status`.
2. Identify unrelated dirty changes.
3. Stage only effort-owned code/test/docs plus required Doric artifacts:
   effort file, generated `STATE.md` projection, validation record, and
   optional accepted agent detail files.
4. Confirm staged paths match effort ownership and reviewer approval.
5. Commit with `<type>(<scope>): <summary>`.
6. Submit the commit subject and hash through the harness so generated
   `STATE.md` records the checkpoint.

If staging or commit fails, request a harness failure transition that restores
the effort and generated `STATE.md` projection to the pre-completion
`in-progress` state, keeps locks visible, records the blocker, and does not
increment `Next effort index`.

## Repair Policy

Repair is bounded and evidence-driven.

Allowed repair triggers:

- Failing focused or regression command.
- Reviewer-scoped diff issue.
- Missing validation record detail.
- Formatting or lint failure inside active ownership.
- Missing or weak test coverage for the active acceptance criteria.
- Small implementation defect localized to active write scope.

Not allowed:

- Starting a later effort.
- Rewriting the effort plan without updating decomposition artifacts and
  approval.
- Broad refactors outside the active effort.
- Changing accepted PRD/TDD scope.
- Staging unrelated worktree changes.
- Treating a repair writer as reviewer approval.

Default circuit breaker:

```text
implementation/validation attempts per effort: 5
repair agents per concrete finding: 1 fresh agent at a time
```

When the circuit breaker trips, stop at the active effort and report current
effort path, `Next effort index`, focused command failure, diff summary,
attempt count, commit state, and the smallest next user decision needed.

## Validation Record Contract

Validation records live under `<run>/validation/` and use this schema:

```markdown
# Validation: <effort name>

## Red evidence

## Green evidence

## Focused commands

## Regression commands

## Unavailable tooling

## Refactors applied

## Reviewer decision
```

The validation record is not optional. If tooling is unavailable, record the
blocker and residual risk instead of claiming completion.

## Development Completion Checks

An effort can move from `in-progress` to `done` only when:

- The effort file status, harness effort state, and generated `STATE.md`
  effort row are all `in-progress`.
- Red evidence exists or has an approved exception.
- Green evidence exists.
- The reviewer approves the final diff.
- Required-agent rows and receipt rows are accepted for all development roles.
- Active locks match the changed files and have no unresolved conflict.
- The worktree has been inspected.
- Only effort-owned changes and required Doric artifacts are staged.
- The conventional commit checkpoint succeeds.

After commit, the Supervisor sets the effort file status to `done` and requests
the harness completion transition. The harness records validation and commit
checkpoints, releases locks, clears `Current effort`, increments `Next effort
index`, regenerates `STATE.md`, and only then may the Supervisor resolve the
next legal effort.

## Research Basis

Agentless motivates the default development shape: keep the execution path
simple, interpretable, and close to localization, repair, and patch validation.
Doric adds red/green testing, sub-agent receipts, worktree safety, and commit
checkpoints because development runs inside a shared repository with durable
workflow gates.

SWE-agent motivates investing in the agent-computer interface: agents need
clear file navigation, edit scope, command execution, and test feedback. Doric
expresses that as explicit read/write ownership, focused commands, validation
records, and reviewable diffs.

AutoCodeRover motivates structural localization and test-guided context
selection. Doric applies this by requiring target files, coupled files,
regression suites, and red tests before implementation.

Reflexion and Self-Refine motivate bounded feedback loops, but development does
not use open-ended self-improvement. Doric turns feedback into concrete repair
findings, fresh repair agents, revalidation, and review.

MetaGPT supports role-specific execution with intermediate verification. Doric
keeps those roles narrow so test writing, code writing, validation, and review
do not collapse into one unreviewable agent turn.

Sources:

- [Agentless: Demystifying LLM-based Software Engineering Agents](https://arxiv.org/abs/2407.01489)
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)
- [AutoCodeRover: Autonomous Program Improvement](https://arxiv.org/abs/2404.05427)
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
- [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)
- [MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework](https://arxiv.org/abs/2308.00352)

## Failure Modes

| Failure mode                                      | Mitigation                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Development starts before implementation approval | Check `decomposition_to_implementation` and effort order before any worker spawn.          |
| A later effort starts early                       | Resolve only the row where `Index == Next effort index`.                                   |
| Test writer also writes implementation            | Give test writer test-only ownership and review changed paths before accepting.            |
| Code writer edits outside ownership               | Use active locks, changed-path review, and block on scope conflicts.                       |
| Red evidence is skipped                           | Require validation record red evidence before code writing, with explicit exceptions only. |
| Green evidence is weak                            | Reviewer verifies focused and regression commands against effort acceptance criteria.      |
| Repair loops drift                                | Spawn fresh bounded repair writers only for concrete findings and rerun validation.        |
| Unrelated dirty work is staged                    | Inspect status, stage exact paths only, and record blockers instead of rollback.           |
| Commit fails after status update                  | Restore status to `in-progress`, keep locks, record blocker, and do not advance.           |

## Minimal Implementation

A minimal Step 05 implementation needs:

1. `STATE.md` readiness and next-effort resolver.
2. Atomic `todo -> in-progress` transition with active locks.
3. Test planner role.
4. Test writer role with red evidence.
5. Code writer role with coding-conventions gate.
6. Validator/refactor role with green evidence.
7. Reviewer role.
8. Bounded repair writer path for concrete findings.
9. Validation record writer.
10. Scoped commit checkpoint path.
11. Atomic completion transition that releases locks and advances
    `Next effort index`.

It does not need candidate tournaments, parallel effort execution, Rust API
changes, a new run-layout contract, or broad rollback automation.

## Summary

Step 05 Development is a strict, one-effort-at-a-time execution loop. It keeps
Doric's multi-agent structure, but uses the simplest effective software
engineering baseline: localize, test, patch, validate, review, commit. The
Supervisor enforces state, locks, receipts, evidence, and worktree boundaries so
development can advance without skipping gates or absorbing unrelated changes.
