# Decomposition Agent Grounding Architecture

This document defines Doric Step 04 Decomposition. It is internal,
self-contained guidance for turning an accepted `PRD.md` and accepted `TDD.md`
into `FEATURES.md` and ordered implementation efforts without losing
grounding, traceability, or phase-gate proof.

Decomposition is the last planning phase before code changes. It may use
bounded candidate generation and ranking, but only after candidates pass
coverage, grounding, and effort-validity checks. Ranking is a selection aid, not
approval.

## Purpose

Step 04 answers one question:

```text
What is the smallest ordered set of implementation efforts that faithfully
satisfies the accepted PRD and TDD?
```

Step 04 must not decide:

- Whether development may begin without explicit
  `decomposition_to_implementation` approval.
- Which accepted PRD requirement or TDD component may be ignored.
- Which product or architecture gap should be silently answered.
- Which effort may run out of numeric order.
- Which implementation patch should be written.

The phase output is a validated decomposition package. Development may start
only after the package is published, required-agent proof is accepted, and the
human implementation gate is accepted by the workflow state harness and
projected into `STATE.md`.

## Non-Negotiable Rules

- Do not begin unless the workflow state harness has approved
  `tdd_to_decomposition` and the generated `<run>/STATE.md` projection shows
  that approval for audit.
- Treat `<run>/PRD.md` and `<run>/TDD.md` as accepted source artifacts. If the
  run layout stores phase-local promoted files under `<run>/prd/PRD.md` or
  `<run>/tdd/TDD.md`, the Supervisor must resolve the current accepted path
  from harness state and its `STATE.md` projection before spawning agents.
- Keep required outputs unchanged: `<run>/FEATURES.md`,
  `<run>/efforts/NN_*.md`, `<run>/STATE.md`, optional `<run>/logs/`, optional
  `<run>/agents/`, and later `<run>/validation/*.md`.
- Do not write implementation code or tests during decomposition.
- Do not rank an unvalidated candidate.
- Do not promote a candidate with a hard-constraint conflict, missing PRD/TDD
  coverage, duplicate effort scope, invalid effort order, or broad ownership.
- Effort filenames must use contiguous two-digit prefixes from `01_` through
  `NN_`.
- Development parallelism is not authorized by decomposition. Efforts execute
  one at a time in numeric order.
- Before development starts, the harness must record the ordered effort list,
  `Next effort index: 0`, accepted decomposition receipt rows, and explicit
  `decomposition_to_implementation` approval, then project those facts into
  `STATE.md`.

## Workflow State Authority

In the target architecture, the workflow state harness owns canonical
decomposition phase transitions, approval state, effort-order state, and the
handoff to development. The Decomposition Supervisor supplies validated
artifacts and approval evidence, but the harness decides whether the transition
is legal.

`STATE.md` remains the durable generated projection and audit ledger. Humans
and agents read it to review phase status, approvals, required-agent receipts,
active locks, and effort order; they do not manually edit it as the canonical
source of transition truth.

## Grounding Model

Grounding is the set of constraints and conventions every decomposition
candidate must obey.

Hard constraints include Doric workflow gates, accepted user decisions, current
repository package responsibilities, dependency direction, safety boundaries,
artifact schemas, required sub-agent proof, and worktree safety.

Convention parameters include preferred effort size, local test style,
regression-suite selection, file ownership boundaries, and documentation
provenance.

When inputs conflict, apply this authority order:

1. System and runtime safety requirements.
2. Doric workflow gates and repository-level grounding.
3. User-approved hard constraints for the current run.
4. Accepted `PRD.md` requirements, non-goals, and validation expectations.
5. Accepted `TDD.md` components, Dependency Hops, and technical constraints.
6. Current repository source, manifests, tests, generated contracts, schemas,
   and architecture documents.
7. Existing Doric skill references and run-state schemas.
8. Convention parameters and method guidance.
9. Candidate ranking score.

Candidate ranking is intentionally last. A high-ranked plan cannot override a
missing requirement link, invalid effort order, or repository-grounding failure.

## Inputs

| Input            | Path                                                         | Purpose                                                                                                                                       |
| ---------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt state     | `<run>/PROMPT.md`                                            | Preserves accepted task framing, unresolved non-blocking questions, and user decisions that remain relevant to effort scope.                  |
| Accepted PRD     | `<run>/PRD.md` or resolved promoted PRD path                 | Defines product requirements, user-visible behavior, non-goals, acceptance criteria, and validation expectations.                             |
| Accepted TDD     | `<run>/TDD.md` or resolved promoted TDD path                 | Defines technical components, Dependency Hops, repository boundaries, rollout constraints, and testing strategy.                              |
| Grounding        | `GROUNDING.md`, `AGENTS.md`, `.agents/skills/doric/SKILL.md` | Defines hard workflow gates, artifact contracts, package responsibilities, and sub-agent proof requirements.                                  |
| Repo evidence    | Current source, manifests, schemas, tests, docs              | Anchors target files, coupled files, regression suites, package boundaries, and ownership risks in the real repository.                       |
| State projection | `<run>/STATE.md`                                             | Displays harness-generated current phase, approvals, required agents, active locks, effort order, and legal next action for audit and review. |

The Supervisor should read only the repository evidence needed to identify
impact, ownership, and tests. Broaden discovery only when a candidate crosses
package or workflow boundaries.

## Supervisor

The Decomposition Supervisor is phase-local. It owns orchestration and
publication, but it does not satisfy required-agent proof by summarizing work
locally.

Responsibilities:

- Verify with the workflow state harness that the phase may start, using
  `STATE.md` as the generated review surface.
- Build one shared decomposition brief from accepted artifacts and grounding.
- Register required-agent rows before every spawned decomposition role.
- Provide explicit read scope, write scope, output path, validation
  expectation, and stop condition to each sub-agent.
- Own candidate selection, not candidate authorship.
- Exclude malformed or ungrounded candidates before ranking.
- Preserve rejected, repaired, and selected-candidate evidence in compact logs
  or receipt summaries.
- Publish the final `FEATURES.md` and effort files only after validation.
- Present the finalized effort list for explicit implementation approval.
- Submit `decomposition_to_implementation` approval, effort order, and
  `Next effort index: 0` to the harness before development starts.

The Supervisor may ask ranking or repair agents to help, but canonical phase
transition decisions are applied by the workflow state harness from durable
evidence.

## Agent Set

Use the smallest set that covers the feature. The default decomposition roles
are:

| Role                               | Agent type         | Purpose                                                                                                       | Output                                                            |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| requirement extractor              | explorer           | Map PRD requirements, user-value hops, TDD components, and Dependency Hops to extracted features.             | Draft or reviewed `<run>/FEATURES.md`.                            |
| repo impact cartographer           | explorer           | Identify target files, coupled files, regression suites, generated artifacts, and ownership risks.            | Impact notes for `FEATURES.md` and effort planning.               |
| effort planner candidates          | worker             | Generate two or three materially different effort-plan candidates when more than one valid sequencing exists. | Candidate effort maps and draft effort files or structured plans. |
| proximity/dedup reviewer           | explorer           | Remove near-duplicate effort plans and identify overlapping or split-too-fine effort boundaries.              | Dedup and similarity report.                                      |
| decomposition reflection validator | explorer           | Check requirement coverage, grounding, order, ownership, scope, and testability.                              | Validity findings and candidate eligibility.                      |
| ranking judge                      | explorer, optional | Rank only validated candidates when multiple candidates remain.                                               | Ranking notes tied to validation evidence.                        |
| evolution repair agent             | worker, optional   | Repair one selected candidate when gaps are concrete and repairable without changing accepted PRD/TDD scope.  | Child candidate plus lineage and addressed findings.              |
| publisher                          | worker             | Publish `FEATURES.md` and contiguous effort files from the selected validated candidate.                      | Final artifacts under the run root and `efforts/`.                |

For a small or obvious feature, the Supervisor may skip candidate plurality,
ranking, and evolution. It still must run coverage extraction, validation,
publication, and the implementation approval gate.

## Candidate Policy

Candidate generation is useful when sequencing, ownership, or test strategy has
more than one plausible shape. It is waste when the accepted TDD implies one
small direct patch.

Default budget:

```text
candidate count: 2 to 3 when useful
ranking pass: 1
repair pass: 1
```

Generate multiple candidates only when at least one condition holds:

- The TDD spans multiple packages or ownership boundaries.
- There are competing ways to isolate user-visible increments.
- Test strategy can be ordered in meaningfully different ways.
- A dependency or migration risk could make one effort order safer than
  another.
- The feature is large enough that a wrong split would create broad, hard to
  review patches.

Do not generate multiple candidates for a single narrow edit with obvious tests.

## Flow

```text
Accepted PRD and accepted TDD
  |
  v
Workflow state harness verifies tdd_to_decomposition approval
  |
  v
Requirement extractor drafts FEATURES.md coverage
  |
  v
Repo impact cartographer maps target files and tests
  |
  v
Effort planner generates one plan, or 2-3 candidates when warranted
  |
  v
Proximity/dedup reviewer removes overlap and duplicate candidates
  |
  v
Reflection validator checks coverage, order, ownership, scope, and tests
  |
  +-- no valid candidate: block or run one repair pass for concrete gaps
  |
  v
Optional ranking judge ranks only validated candidates
  |
  v
Publisher writes FEATURES.md and contiguous efforts/NN_*.md
  |
  v
Supervisor submits effort order to harness and asks for implementation approval
```

Ranking must receive validation evidence with every candidate. If validation
finds a hard-constraint conflict, the candidate is rejected before ranking. If a
candidate is repairable, the repair agent creates a child candidate with
lineage; the child returns to validation before ranking or publication.

## FEATURES.md Contract

`FEATURES.md` is the bridge from accepted artifacts to implementation efforts.
It must map every source requirement and technical component to a feature or to
an explicit exclusion.

Required sections:

```markdown
# Features

## Source artifacts

## Extracted features

## Requirement coverage map

## Technical coverage map

## Assumption coverage

## Repo impact map

## Effort plan summary

## Exclusions

## Validator notes
```

The coverage maps should be concrete enough for a reviewer to find omissions
without rereading the whole PRD and TDD. The repo impact map should name target
areas, coupled files, regression suites, generated artifacts, and ownership
risks discovered from current repository evidence.

## Effort File Contract

Effort files live under `<run>/efforts/` and use contiguous two-digit prefixes:

```text
01_<effort_name>.md
02_<effort_name>.md
...
NN_<effort_name>.md
```

Required schema:

```markdown
# Effort: <short action>

Status: todo

## Requirement links

## Goal

## Sequence

## Target files

## Coupled files

## Ownership

## Tests to add or update

## Regression suites

## Acceptance criteria

## Notes
```

`Sequence` must name the numeric position and immediate predecessor. `Ownership`
must list write scope, read-only context, and known conflict risks. `Regression
suites` must be narrow enough for the effort but broad enough to prove the
coupled behavior identified by impact analysis.

## Validation Rubric

A decomposition candidate is valid only when all checks pass:

- Every PRD requirement maps to at least one feature and effort, or to an
  explicit exclusion.
- Every TDD component and Dependency Hop maps to at least one feature and
  effort, or to an explicit exclusion.
- Every effort traces back to accepted PRD/TDD scope.
- No effort introduces product or architecture scope outside accepted artifacts.
- No two efforts own the same write scope unless sequencing prevents conflict.
- Efforts are small, independently reviewable, and ordered by dependency.
- Effort filenames form a contiguous `01_` to `NN_` sequence.
- Every effort starts with `Status: todo`.
- Target files, coupled files, ownership, tests, and regression suites are
  grounded in current repository evidence.
- Acceptance criteria are specific enough for test-planning.
- No development effort is started, marked `in-progress`, or assigned locks
  before implementation approval.

The validator should reject broad ownership such as "entire package" unless the
TDD proves that the effort truly requires package-wide changes and the effort
still has a focused regression plan.

## Ranking Rules

Ranking is optional and runs only after validation.

A ranking judge should prefer the candidate that:

- Preserves full PRD/TDD coverage.
- Minimizes cross-package ownership in each effort.
- Orders risk-reducing and test-enabling work first.
- Keeps each effort reviewable and commit-sized.
- Names realistic red and green validation paths.
- Leaves unrelated worktree and package boundaries untouched.
- Makes harness-projected effort order and `Next effort index` easy to verify
  in `STATE.md`.

Ranking must not promote:

- An unvalidated candidate.
- A candidate with any hard-constraint conflict.
- A candidate that depends on a missing user decision.
- A candidate that hides duplicate or overlapping effort ownership.

## Evolution Repair

Use one bounded repair pass when validation finds concrete, repairable gaps.

Allowed repair triggers:

- Missing coverage map entries.
- Duplicate or overlapping efforts.
- Non-contiguous prefixes.
- Oversized effort boundaries.
- Missing target files, coupled files, tests, or regression suites.
- Weak sequence justification.
- Scope wording that can be tightened without changing accepted PRD/TDD intent.

Stop and ask the user, or return to the correct earlier phase, when repair
would change accepted product scope, alter the accepted technical design, remove
a requested requirement, choose between unresolved architecture strategies, or
violate a hard constraint.

Every repaired child candidate must record:

- Parent candidate id or title.
- Triggering findings.
- Allowed repair scope.
- Changes made.
- Requirements preserved.
- Remaining risks.

The child candidate returns to validation before ranking or publication.

## State Updates

Before requesting implementation approval, the Supervisor submits durable facts
to the workflow state harness so the generated `STATE.md` projection records:

- Accepted required-agent rows for every active decomposition role.
- Accepted `Agent receipts` rows with spawn proof and concise outcomes.
- The published `FEATURES.md` path.
- The ordered effort filenames.
- Any rejected or superseded candidate evidence needed for auditability.

After the user explicitly approves implementation, the harness records the
canonical transition and regenerates `STATE.md` with:

- `decomposition_to_implementation` as approved.
- Every effort filename in the `Effort order` table with `Status: todo`.
- `Current effort: none`.
- `Next effort index: 0`.
- No active locks.
- `Phase: development`.

Development agents must not be spawned before these records exist.

## Research Basis

This phase adapts the AI co-scientist pattern only where it fits Doric's
planning problem: specialized agents, supervisor-owned selection, proximity,
reflection, ranking, and bounded evolution. The paper's generate, debate, and
evolve approach plus tournament evolution informs candidate planning, but Doric
adds stricter artifact gates because implementation depends on durable files
and human approvals.

MetaGPT supports the choice to encode SOP-style role responsibilities and
intermediate verification rather than loosely chaining agents. Decomposition
uses role separation to reduce cascading mistakes in requirements coverage,
impact mapping, and effort planning.

Agentless is the counterweight: its localization, repair, and patch-validation
pipeline shows that simple, interpretable software-engineering flows can be
strong baselines. Doric therefore uses candidate ranking in decomposition only
when there is real planning ambiguity.

AutoCodeRover supports repo impact cartography through structure-aware code
search and test-guided localization. Doric applies that idea to effort
planning by requiring target files, coupled files, and regression suites before
development starts.

Reflexion and Self-Refine support bounded feedback and repair without model
training. Doric constrains that pattern to one repair pass over concrete
validator findings, with lineage and revalidation.

Sources:

- [Towards an AI co-scientist](https://arxiv.org/abs/2502.18864)
- [MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework](https://arxiv.org/abs/2308.00352)
- [Agentless: Demystifying LLM-based Software Engineering Agents](https://arxiv.org/abs/2407.01489)
- [AutoCodeRover: Autonomous Program Improvement](https://arxiv.org/abs/2404.05427)
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
- [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)

## Failure Modes

| Failure mode                                    | Mitigation                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Candidate ranking rewards fluency over validity | Validate coverage, grounding, order, and ownership before ranking.                   |
| Decomposition drops a PRD requirement           | Require a coverage map from PRD requirements to features and efforts.                |
| Decomposition drops a TDD component             | Require a technical coverage map from TDD components and Dependency Hops to efforts. |
| Efforts overlap or duplicate ownership          | Run proximity/dedup review and record write scopes in every effort.                  |
| Effort order has gaps or duplicates             | Enforce contiguous prefixes and project the ordered list into `STATE.md`.            |
| Effort scope is too broad                       | Require target files, coupled files, tests, ownership, and acceptance criteria.      |
| Decomposition starts development implicitly     | Block all development roles until `decomposition_to_implementation` is approved.     |
| Repair changes accepted scope                   | Stop and return to the user or earlier phase instead of repairing locally.           |

## Minimal Implementation

A minimal Step 04 implementation needs:

1. Harness-backed readiness check for `tdd_to_decomposition`, projected into
   `STATE.md`.
2. Shared decomposition brief builder.
3. Requirement extractor.
4. Repo impact cartographer.
5. Effort planner.
6. Decomposition validator.
7. Optional candidate ranking when more than one validated plan exists.
8. Optional one-pass repair for concrete validator findings.
9. Publisher for `FEATURES.md` and contiguous effort files.
10. Harness-backed effort-order and implementation-approval update path with
    generated `STATE.md` projection.

It does not need Rust API changes, implementation patching, test writing,
parallel development, or a new run-layout contract.

## Summary

Step 04 Decomposition is a supervisor-led planning phase that converts accepted
requirements and technical design into an ordered, validated implementation
queue. It can borrow the AI co-scientist candidate-review pattern for ambiguous
planning, but its final authority remains Doric grounding, current repository
evidence, durable receipts, contiguous effort files, and explicit human
approval before development. Canonical transition authority belongs to the
workflow state harness, with `STATE.md` serving as the generated audit ledger.
