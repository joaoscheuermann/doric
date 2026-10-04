# TDD Evolution Grounding Architecture

This document defines Doric's TDD Evolution loop: the controlled repair and
refinement process for promising Technical Design Document candidates.
Evolution improves candidates only by using the accepted PRD, hard constraints,
convention parameters, current repository evidence, Reflection findings,
tournament evidence, proximity evidence, Dependency Hop evidence, and recorded
lineage.

Evolution is not a drafting phase and does not promote a TDD by itself. It
creates a new child TDD candidate, records why the child exists, and sends the
child back through Reflection before the candidate can be ranked or accepted.

## Core Rules

- Evolution creates a new child candidate.
- Evolution never edits the parent candidate in place.
- Evolution never guesses missing product intent or irreversible architecture
  decisions.
- Evolution preserves parent lineage and accepted PRD requirements unless an
  explicit repair scope allows a change.
- Evolution changes only what the trigger and allowed repair scope justify.
- Every child candidate re-enters Reflection before tournament entry or
  promotion.
- The workflow state harness owns canonical gate and transition decisions; the
  Supervisor supplies evidence and the Evolution agent owns only the child
  draft and evidence record.

## Phase Position

Initial TDD Generation creates sibling candidates from the accepted PRD,
architecture-scoped prompt state, and repository evidence. Evolution creates
child candidates from existing reviewed candidates and concrete repair evidence.

Normal Step 03 flow:

```text
Prompt Ingestion
  -> PRD Evolution and Promotion
  -> TDD Generation
  -> Proximity Filtering
  -> Reflection
  -> TDD Tournament
  -> Evolution, only when needed
  -> Reflection again
  -> Champion TDD promotion
  -> tdd_to_decomposition approval
```

Evolution can run before tournament entry when Reflection finds repairable
gaps. It can run after a tournament when the champion has repairable warnings
or when another reviewed candidate contains a compatible concept worth
grafting.

Evolution must stop and return to the user when the repair requires a product
decision, expands accepted PRD scope, removes an explicitly requested
requirement, chooses between incompatible architecture strategies without an
approved policy, or depends on an irreversible architecture decision that needs
human judgment.

## Workflow State Authority

In the target architecture, Evolution records repair evidence and child
lineage, while the workflow state harness owns canonical transitions for
allowed repair, Reflection re-entry, promotion readiness, and user-input waits.

`STATE.md` is regenerated from harness state as the durable projection and
audit ledger. Agents and humans read it to review Evolution receipts and gate
status; they do not use manual `STATE.md` edits as the transition source of
truth.

## Grounding Order

The Evolution operation type is the lowest authority. A simplification,
combination, or divergent child cannot override accepted scope, current
repository facts, or hard constraints.

Use this authority order when evaluating a proposed child:

1. System and runtime safety requirements.
2. Doric workflow constraints and active run gates.
3. User-approved hard constraints for the current run.
4. Accepted `<run>/prd/PRD.md` requirements and non-goals.
5. Parent candidate lineage and accepted parent technical decisions.
6. Reflection findings that triggered repair.
7. Tournament findings that triggered repair.
8. Architecture-scoped prompt constraints.
9. Current repository evidence.
10. Proximity evidence.
11. Convention parameters.
12. Evolution operation type.

## Inputs

Evolution receives a structured input package. It should not operate on a loose
instruction such as "make this better" unless the user explicitly requests a
creative refinement and the run records that as the trigger.

Required fields:

| Field                    | Purpose                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `parent_candidate_id`    | Stable identifier of the TDD being evolved.                                                           |
| `parent_title`           | Human-readable parent title.                                                                          |
| `parent_path`            | Parent artifact path.                                                                                 |
| `parent_origin`          | Architect lens, prior Evolution run, user contribution, or other origin.                              |
| `parent_review_evidence` | Reflection evidence attached to the parent.                                                           |
| `trigger`                | Why Evolution is running.                                                                             |
| `triggering_findings`    | Specific findings, warnings, match notes, Dependency Hop notes, or proximity notes to address.        |
| `grounding_snapshot`     | Hard constraints and convention parameters active for the run.                                        |
| `accepted_prd_snapshot`  | PRD requirements, non-goals, acceptance criteria, and validation expectations relevant to the repair. |
| `architecture_context`   | Current repository evidence relevant to the repair.                                                   |
| `allowed_change_scope`   | Sections, claims, contracts, Dependency Hops, or test strategy items Evolution may modify.            |
| `preserve_requirements`  | PRD requirements, prompt constraints, and technical decisions that must remain intact.                |
| `lineage_chain`          | Ordered ancestry from original candidate to the parent.                                               |

Common trigger values:

| Trigger                      | Meaning                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `reflection_needs_evolution` | Reflection found repairable gaps before tournament eligibility.                    |
| `tournament_champion_repair` | The tournament found a strong champion with repairable warnings.                   |
| `tournament_concept_graft`   | A losing reviewed candidate has a useful compatible technical concept.             |
| `proximity_combination`      | Proximity found related candidates whose strengths may combine safely.             |
| `dependency_hop_gap`         | A Dependency Hop is unverified, impossible, missing evidence, or needs a fallback. |
| `meta_review_recurring_gap`  | Meta-review found a repeated weakness that should be repaired in a child.          |
| `human_directed_refinement`  | The user explicitly asked to refine a reviewed candidate.                          |

Evolution may read the parent TDD, parent assumptions, proposed design,
Dependency Hops, contracts, testing strategy, risks, tradeoffs, review
evidence, tournament history, accepted PRD, and relevant repository evidence.
The parent remains immutable.

## Outputs

### Child TDD Candidate

The child is a new raw TDD candidate with its own artifact path.

Required fields:

| Field                       | Purpose                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `candidate_id`              | Stable identifier for the child.                                                                |
| `title`                     | Human-readable child title.                                                                     |
| `path`                      | Child artifact path.                                                                            |
| `parent_candidate_id`       | Direct parent id.                                                                               |
| `parent_path`               | Direct parent artifact path.                                                                    |
| `evolution_trigger`         | Trigger copied from the input package.                                                          |
| `evolution_operation`       | Operation used to create the child.                                                             |
| `addressed_findings`        | Findings the child attempted to repair.                                                         |
| `addressed_dependency_hops` | Dependency Hops the child repaired, removed, replaced, or converted to blocking questions.      |
| `preserved_from_parent`     | PRD requirements, scope boundaries, architecture constraints, or technical contracts preserved. |
| `changed_from_parent`       | Sections, claims, contracts, Dependency Hops, or tests changed.                                 |
| `new_assumptions`           | New assumptions introduced, clearly labeled.                                                    |
| `lineage_chain`             | Parent lineage plus the child id.                                                               |

The child should be recorded separately from the parent, for example:

```text
<run>/tdd/logs/evolution.md child candidate entry
```

The invariant is that the child has a distinct candidate id and does not
silently overwrite the parent. If the child becomes the current champion, write
that champion to `<run>/tdd/TDD.md`.

### Evolution Record

Every Evolution run should also write an evidence record, for example:

```text
<run>/tdd/logs/evolution.md evolution record
<run>/STATE.md Agent receipts
```

The record should include:

- Parent id and path.
- Child id and path.
- Trigger and operation type.
- Inputs read.
- Findings addressed.
- Dependency Hops addressed.
- Requirements preserved.
- Technical decisions changed.
- Grounding constraints checked.
- Repository evidence used.
- Why the child is expected to be better.
- Remaining risks.
- Required Reflection rerun scope.

## Operations

| Operation                      | Use When                                                                                                                            | Guardrail                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Grounding repair               | The candidate misses hard constraints, convention parameters, accepted PRD context, or repository grounding.                        | Do not add new product scope.                                  |
| Architecture fit repair        | The candidate violates package ownership, dependency direction, current boundaries, or repo patterns.                               | Prefer existing architecture before adding structure.          |
| Dependency Hop repair          | A hop is missing evidence, impossible, vague, or lacks a fallback.                                                                  | Repair the assumption or convert it into a blocking question.  |
| Interface repair               | APIs, commands, events, tools, schemas, or UI states are ambiguous or untestable.                                                   | Keep interfaces minimal and aligned to current boundaries.     |
| Test strategy repair           | The validation path is too broad, missing, flaky, or detached from existing tooling.                                                | Preserve PRD acceptance criteria while making proof practical. |
| Security and operations repair | The candidate under-specifies trust boundaries, secrets, permissions, command execution, network access, failure, or observability. | Do not weaken safety or permission boundaries.                 |
| Concept grafting               | A reviewed losing candidate contains one compatible technical idea that improves the parent.                                        | Import only the compatible concept, not unresolved blockers.   |
| Candidate combination          | Reviewed candidates have complementary strengths and compatibility evidence.                                                        | Do not create a bloated union of every idea.                   |
| Simplification                 | The parent is too broad, costly, risky, or difficult to verify.                                                                     | Preserve accepted PRD requirements.                            |
| Divergent child                | Candidates are stuck, overfit, too similar, or repeatedly fail the same review.                                                     | Stay within accepted PRD intent and run full Reflection.       |

Grounding repair usually adds missing constraints, makes conventions explicit,
removes unsupported claims, or explains justified deviations.

Architecture fit repair usually moves responsibilities back to their package,
reduces invalid dependencies, reuses existing extension points, or updates the
design to match current code.

Dependency Hop repair usually replaces unsupported assumptions with evidence,
adds failure modes, names fallbacks, or blocks on a real architecture question.

Test strategy repair usually narrows proofs, maps acceptance criteria to
existing test tooling, identifies fixtures, or separates red/green evidence for
development efforts.

Simplification is often the safest operation because implementation cost and
risk compound quickly.

Divergent Evolution is bounded repair, not a new Generation phase.

## Grounded Flow

```text
Repair signal from Reflection, Tournament, Proximity, Meta-review, Dependency Hop review, or user
  |
  v
Supervisor asks workflow state harness to verify Evolution is allowed
  |
  v
Supervisor builds input package with parent lineage, PRD snapshot, repo evidence, and findings
  |
  v
Supervisor selects or constrains the Evolution operation
  |
  v
Evolution agent reads parent, evidence, grounding, and allowed scope
  |
  v
Evolution agent writes child TDD candidate
  |
  v
Evolution agent writes evidence record
  |
  v
Supervisor validates child artifact contract and lineage
  |
  v
Child TDD re-enters Reflection
```

## Supervisor Responsibilities

The Supervisor coordinates Evolution evidence and asks the workflow state
harness to apply transition and gate decisions.

Responsibilities:

- Verify the trigger is valid.
- Verify no missing product or architecture decision is being repaired by the
  model.
- Build the Evolution input package.
- Select or constrain the operation.
- Provide grounding, accepted PRD scope, repository evidence, and allowed
  change scope.
- Enforce child artifact path and lineage.
- Preserve the parent candidate.
- Record Evolution output.
- Send the child back to Reflection.
- Bound repair cycles.

The Supervisor may ask an LLM to recommend an operation type, but transition
rules must remain explicit in the harness.

## Operation Selection

Use this default selector unless a run-specific policy overrides it:

```text
if findings include missing grounding:
    use grounding_repair
else if findings include package ownership or dependency-direction mismatch:
    use architecture_fit_repair
else if findings include missing, vague, unverified, or impossible Dependency Hops:
    use dependency_hop_repair
else if findings include unclear API, command, event, tool, schema, or UI contract:
    use interface_repair
else if findings include weak validation, vague tests, or decomposition risk:
    use test_strategy_repair
else if findings include security, permission, command, network, persistence, or operations risk:
    use security_and_operations_repair
else if tournament notes identify one useful losing concept:
    use concept_grafting
else if proximity or tournament notes identify compatible reviewed parents:
    use candidate_combination
else if findings say the design is too broad, costly, or risky:
    use simplification
else if repeated failures show candidates are overfit or too similar:
    use divergent_child
else:
    use dependency_hop_repair
```

## Reflection Re-entry

Every child TDD returns to Reflection.

Reflection may be narrow when:

- The parent already passed most reviews.
- The child changed only sections implicated by findings.
- The lineage record identifies the repair scope.
- No new assumptions, interfaces, product scope, or package ownership changes
  were introduced.

Reflection must be full when:

- The child is divergent.
- The child combines multiple candidates.
- The child changes package ownership, dependency direction, API contracts,
  data model, security model, testing strategy, rollout plan, or risk model.
- The child introduces new assumptions.
- The child changes hard-constraint interpretation.
- The lineage record is incomplete.

The child cannot enter the tournament until Reflection returns `eligible` or
`eligible_with_warnings`.

## Relationship To Other Step 03 Gates

Tournament provides champion repair notes, losing concepts worth preserving,
match rationales, similarity observations, rating patterns, and candidate
weaknesses. Evolution turns that evidence into a child candidate; it does not
run the tournament.

Proximity helps identify near-duplicates and complementary candidates.
Proximity evidence is advisory. Combination still requires lineage, allowed
scope, and Reflection re-entry.

Meta-review can trigger Evolution when multiple candidates show the same
weakness, such as vague Dependency Hops, repeated convention violations,
overly broad designs, weak validation, or missing architecture evidence.
Meta-review should provide compact repair guidance, not rewrite the TDD itself.

For champion repair in Doric, Evolution stops when the current champion passes
the zero-gap technical gate and can be promoted to `<run>/tdd/TDD.md`. Promotion is
not an Evolution decision. The fresh gap evaluator and championship evaluator
decide whether the child resolves the active `<run>/tdd/GAPS.md` blocker without
introducing a new one.

After promotion, the coordinator must still request explicit user approval
before decomposition and record `tdd_to_decomposition` in `<run>/STATE.md`.

## Human Input Rules

Return to the user when:

- Product scope is ambiguous.
- A product tradeoff requires user preference.
- A hard constraint conflicts with the user request.
- A requirement would materially expand the project.
- A repair would remove something the user explicitly requested.
- An irreversible architecture choice lacks accepted constraints.
- Two parent candidates represent incompatible technical strategies and no
  approved policy chooses between them.

Evolution may proceed when:

- The repair stays inside accepted PRD scope.
- The finding is about clarity, validation, feasibility, grounding,
  architecture fit, Dependency Hops, or decomposition readiness.
- The change preserves user-approved requirements.
- Reflection can validate the repair.

## Stop Rules

Recommended defaults:

| Rule                              | Default                        |
| --------------------------------- | ------------------------------ |
| Attempts per Reflection cycle     | 1                              |
| Attempts after champion repair    | 1                              |
| Full cycles before asking user    | 2                              |
| Divergent children per stuck loop | 1                              |
| Combination parents               | 2 unless explicitly configured |

Stop when:

- The child passes Reflection and can enter the tournament.
- The child still fails the same blocking review after the repair budget.
- The repair requires user input.
- The child would violate a hard constraint.
- Evolution would need to change accepted PRD scope.
- The operation would collapse into new Generation.

If the repair budget is exhausted, preserve the last verified champion and
report whether it is `champion_confident`, `best_under_budget`, or blocked by
user input. Only `champion_confident` plus a zero-gap technical gate can be
promoted to `<run>/tdd/TDD.md`, and decomposition still requires
`tdd_to_decomposition` approval.

## Artifact Contract

A minimal implementation persists:

| Artifact                        | Purpose                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<run>/tdd/logs/evolution.md`   | Child candidate entries, evolution records, lineage, blockers, and champion summaries.                                   |
| `<run>/tdd/TDD.md`              | Current champion after accepted promotion.                                                                               |
| `<run>/tdd/GAPS.md`             | Active blocking technical gap that a Challenger must resolve.                                                            |
| `<run>/STATE.md` Agent receipts | Harness-generated audit projection of spawn proof and acceptance status for Evolution, mutation, and championship roles. |

Each child should be discoverable from parent id, parent path, child id, child
path, trigger, operation, addressed findings, addressed Dependency Hops, and
lineage chain.

`<run>/tdd/GAPS.md` is not a separate repair process. It is the active technical
gap artifact that a Challenger must resolve before the champion can be
promoted. Evolution still creates the child candidate, and Reflection still
decides whether the child is eligible.

## Failure Modes

| Failure mode                                  | Risk                                                       | Mitigation                                                                              |
| --------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Evolution edits the parent in place           | Review and tournament evidence becomes unrecoverable.      | Always write a child candidate with a distinct path.                                    |
| Evolution invents missing product intent      | The workflow silently chooses for the user.                | Route scope-defining gaps to the user or PRD repair.                                    |
| Evolution invents current architecture facts  | The TDD becomes unimplementable or unsafe.                 | Require repository evidence for current-code claims.                                    |
| Evolution bypasses Reflection                 | Repaired drafts enter ranking without review.              | Treat every child as raw until Reflection approves it.                                  |
| Combination bloats the TDD                    | The child accumulates every idea from every parent.        | Combine only compatible strengths tied to findings.                                     |
| Simplification removes required scope         | The child becomes easy but wrong.                          | Preserve accepted PRD requirements unless the user changes them.                        |
| Grounding repair adds unsupported constraints | Assumptions are treated as authoritative.                  | Distinguish hard constraints from conventions and assumptions.                          |
| Dependency Hop repair hides a blocker         | A false assumption reaches decomposition.                  | Convert unsupported hops into explicit blockers or fallbacks.                           |
| Divergent Evolution becomes new Generation    | Repair restarts exploration without bounds.                | Use divergent children only for repeated failures and run full Reflection.              |
| Lineage is incomplete                         | Humans and agents cannot reconstruct why the child exists. | Require parent id, parent path, trigger, findings, changed sections, and affected hops. |

## Minimal Implementation

A minimal TDD Evolution implementation needs:

1. Trigger detection from Reflection, Tournament, Proximity, Meta-review,
   Dependency Hop review, or user input.
2. Evolution input package builder.
3. Operation selector.
4. Child TDD writer with a distinct path.
5. Lineage fields on every child.
6. Evolution record.
7. Basic child artifact validation.
8. Re-entry into Reflection.
9. Repair budget enforcement.

It does not need raw architect draft generation, tournament matches, Reflection
execution inside Evolution, code mutation, decomposition, or automatic
promotion.
