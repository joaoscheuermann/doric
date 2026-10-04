# PRD Evolution Grounding Architecture

This document defines Doric's PRD Evolution loop: the controlled repair and
refinement process for promising PRD candidates. Evolution improves candidates
only by using accepted user intent, hard constraints, convention parameters,
Reflection findings, tournament evidence, proximity evidence, and recorded
lineage.

Evolution is not a drafting phase and does not promote a PRD by itself. It
creates a new child PRD candidate, records why the child exists, and sends the
child back through Reflection before the candidate can be ranked or accepted.

## Core Rules

- Evolution creates a new child candidate.
- Evolution never edits the parent candidate in place.
- Evolution never guesses missing user intent.
- Evolution preserves parent lineage and accepted requirements unless an
  explicit repair scope allows a change.
- Evolution changes only what the trigger and allowed repair scope justify.
- Every child candidate re-enters Reflection before tournament entry or
  promotion.
- The workflow state harness owns canonical gate and transition decisions; the
  Supervisor supplies evidence and the Evolution agent owns only the child
  draft and evidence record.

## Phase Position

Initial PRD Generation creates sibling candidates from the accepted Step 01
prompt bundle. Evolution creates child candidates from existing reviewed
candidates and concrete repair evidence.

Normal Step 02 flow:

```text
Prompt Ingestion
  -> PRD Generation
  -> Proximity Filtering
  -> Reflection
  -> PRD Tournament
  -> Evolution, only when needed
  -> Reflection again
```

Evolution can run before tournament entry when Reflection finds repairable
gaps. It can run after a tournament when the champion has repairable warnings
or when another reviewed candidate contains a compatible concept worth
grafting.

Evolution must stop and return to the user when the repair requires a product
decision, expands accepted scope, removes an explicitly requested requirement,
or resolves incompatible strategies without an approved policy.

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
combination, or divergent child cannot override accepted scope or hard
constraints.

Use this authority order when evaluating a proposed child:

1. System and runtime safety requirements.
2. Doric workflow constraints and active run gates.
3. User-approved hard constraints for the current run.
4. Parent candidate lineage and accepted parent requirements.
5. Reflection findings that triggered repair.
6. Tournament findings that triggered repair.
7. Accepted Step 01 prompt artifacts.
8. Product and technical needs from Step 01.
9. Proximity evidence.
10. Convention parameters.
11. Evolution operation type.

## Inputs

Evolution receives a structured input package. It should not operate on a loose
instruction such as "make this better" unless the user explicitly requests a
creative refinement and the run records that as the trigger.

Required fields:

| Field                      | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `parent_candidate_id`      | Stable identifier of the PRD being evolved.                                |
| `parent_title`             | Human-readable parent title.                                               |
| `parent_path`              | Parent artifact path.                                                      |
| `parent_origin`            | PM lens, prior Evolution run, user contribution, or other origin.          |
| `parent_review_evidence`   | Reflection evidence attached to the parent.                                |
| `trigger`                  | Why Evolution is running.                                                  |
| `triggering_findings`      | Specific findings, warnings, match notes, or proximity notes to address.   |
| `grounding_snapshot`       | Hard constraints and convention parameters active for the run.             |
| `accepted_prompt_snapshot` | Step 01 prompt, product needs, and technical needs relevant to the repair. |
| `allowed_change_scope`     | Sections, claims, or requirements Evolution may modify.                    |
| `preserve_requirements`    | Requirements and decisions that must remain intact.                        |
| `lineage_chain`            | Ordered ancestry from original candidate to the parent.                    |

Common trigger values:

| Trigger                      | Meaning                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `reflection_needs_evolution` | Reflection found repairable gaps before tournament eligibility.           |
| `tournament_champion_repair` | The tournament found a strong champion with repairable warnings.          |
| `tournament_concept_graft`   | A losing reviewed candidate has a useful compatible concept.              |
| `proximity_combination`      | Proximity found related candidates whose strengths may combine safely.    |
| `meta_review_recurring_gap`  | Meta-review found a repeated weakness that should be repaired in a child. |
| `human_directed_refinement`  | The user explicitly asked to refine a reviewed candidate.                 |

Evolution may read the parent PRD, parent assumptions, goals, non-goals,
acceptance criteria, validation expectations, risks, tradeoffs, review
evidence, and tournament history. The parent remains immutable.

## Outputs

### Child PRD Candidate

The child is a new raw PRD candidate with its own artifact path.

Required fields:

| Field                   | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `candidate_id`          | Stable identifier for the child.                                  |
| `title`                 | Human-readable child title.                                       |
| `path`                  | Child artifact path.                                              |
| `parent_candidate_id`   | Direct parent id.                                                 |
| `parent_path`           | Direct parent artifact path.                                      |
| `evolution_trigger`     | Trigger copied from the input package.                            |
| `evolution_operation`   | Operation used to create the child.                               |
| `addressed_findings`    | Findings the child attempted to repair.                           |
| `preserved_from_parent` | Requirements, scope boundaries, or acceptance criteria preserved. |
| `changed_from_parent`   | Sections, claims, or acceptance criteria changed.                 |
| `new_assumptions`       | New assumptions introduced, clearly labeled.                      |
| `lineage_chain`         | Parent lineage plus the child id.                                 |

The child should be recorded separately from the parent, for example:

```text
<run>/prd/logs/evolution.md child candidate entry
```

The invariant is that the child has a distinct candidate id and does not
silently overwrite the parent. If the child becomes the current champion, write
that champion to `<run>/prd/PRD.md`.

### Evolution Record

Every Evolution run should also write an evidence record, for example:

```text
<run>/prd/logs/evolution.md evolution record
<run>/STATE.md Agent receipts
```

The record should include:

- Parent id and path.
- Child id and path.
- Trigger and operation type.
- Inputs read.
- Findings addressed.
- Requirements preserved.
- Requirements changed.
- Grounding constraints checked.
- Why the child is expected to be better.
- Remaining risks.
- Required Reflection rerun scope.

## Operations

| Operation             | Use When                                                                           | Guardrail                                                          |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Grounding repair      | The candidate misses hard constraints, convention parameters, or accepted context. | Do not add new scope.                                              |
| Feasibility repair    | The candidate is aligned but hard to implement, validate, or decompose.            | Keep product intent intact.                                        |
| Coherence repair      | Goals, non-goals, workflows, terminology, risks, or acceptance criteria conflict.  | Preserve the strongest parent framing while fixing contradictions. |
| Concept grafting      | A reviewed losing candidate contains one compatible idea that improves the parent. | Import only the compatible concept, not unresolved blockers.       |
| Candidate combination | Reviewed candidates have complementary strengths and compatibility evidence.       | Do not create a bloated union of every idea.                       |
| Simplification        | The parent is too broad, costly, risky, or difficult to verify.                    | Preserve user-approved requirements.                               |
| Divergent child       | Candidates are stuck, overfit, too similar, or repeatedly fail the same review.    | Stay within accepted intent and run full Reflection.               |

Grounding repair usually adds missing constraints, makes conventions explicit,
removes unsupported claims, or explains justified deviations.

Feasibility repair usually makes acceptance criteria testable, clarifies
validation, narrows risky scope, splits ambiguous requirements, or converts
hidden assumptions into explicit assumptions.

Coherence repair usually aligns goals and non-goals, removes contradictory
requirements, clarifies workflows, and makes risks and acceptance criteria
refer to the same behavior.

Simplification is often the safest operation because implementation cost and
risk compound quickly.

Divergent Evolution is bounded repair, not a new Generation phase.

## Grounded Flow

```text
Repair signal from Reflection, Tournament, Proximity, Meta-review, or user
  |
  v
Supervisor asks workflow state harness to verify Evolution is allowed
  |
  v
Supervisor builds input package with parent lineage and evidence
  |
  v
Supervisor selects or constrains the Evolution operation
  |
  v
Evolution agent reads parent, evidence, grounding, and allowed scope
  |
  v
Evolution agent writes child PRD candidate
  |
  v
Evolution agent writes evidence record
  |
  v
Supervisor validates child artifact contract and lineage
  |
  v
Child PRD re-enters Reflection
```

## Supervisor Responsibilities

The Supervisor coordinates Evolution evidence and asks the workflow state
harness to apply transition and gate decisions.

Responsibilities:

- Verify the trigger is valid.
- Verify no missing user decision is being repaired by the model.
- Build the Evolution input package.
- Select or constrain the operation.
- Provide grounding and allowed change scope.
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
else if findings include weak validation, vague acceptance criteria, or decomposition risk:
    use feasibility_repair
else if findings include contradictions or unclear workflow:
    use coherence_repair
else if tournament notes identify one useful losing concept:
    use concept_grafting
else if proximity or tournament notes identify compatible reviewed parents:
    use candidate_combination
else if findings say scope is too broad or expensive:
    use simplification
else if repeated failures show candidates are overfit or too similar:
    use divergent_child
else:
    use feasibility_repair
```

## Reflection Re-entry

Every child PRD returns to Reflection.

Reflection may be narrow when:

- The parent already passed most reviews.
- The child changed only sections implicated by findings.
- The lineage record identifies the repair scope.
- No new assumptions or product scope were introduced.

Reflection must be full when:

- The child is divergent.
- The child combines multiple candidates.
- The child changes goals, non-goals, users, acceptance criteria, or risk
  model.
- The child introduces new assumptions.
- The child changes hard-constraint interpretation.
- The lineage record is incomplete.

The child cannot enter the tournament until Reflection returns `eligible` or
`eligible_with_warnings`.

## Relationship To Other Step 02 Gates

Tournament provides champion repair notes, losing concepts worth preserving,
match rationales, similarity observations, rating patterns, and candidate
weaknesses. Evolution turns that evidence into a child candidate; it does not
run the tournament.

Proximity helps identify near-duplicates and complementary candidates.
Proximity evidence is advisory. Combination still requires lineage, allowed
scope, and Reflection re-entry.

Meta-review can trigger Evolution when multiple candidates show the same
weakness, such as vague acceptance criteria, repeated convention violations,
overly broad scopes, or missing validation. Meta-review should provide compact
repair guidance, not rewrite the PRD itself.

For champion repair in Doric, Evolution stops when the current champion passes
the zero-gap product gate and can be promoted to `<run>/prd/PRD.md`. Promotion is
not an Evolution decision. The fresh gap evaluator and championship evaluator
decide whether the child resolves the active `<run>/prd/GAPS.md` blocker
without introducing a new one.

## Human Input Rules

Return to the user when:

- Scope is ambiguous.
- A product tradeoff requires user preference.
- A hard constraint conflicts with the user request.
- A requirement would materially expand the project.
- A repair would remove something the user explicitly requested.
- Two parent candidates represent incompatible strategies and no approved
  policy chooses between them.

Evolution may proceed when:

- The repair stays inside accepted scope.
- The finding is about clarity, validation, feasibility, grounding, or
  decomposition readiness.
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
- Evolution would need to change accepted scope.
- The operation would collapse into new Generation.

If the repair budget is exhausted, preserve the last verified champion and
report whether it is `champion_confident`, `best_under_budget`, or blocked by
user input. Only `champion_confident` plus a zero-gap product gate can advance
to technical design.

## Artifact Contract

A minimal implementation persists:

| Artifact                        | Purpose                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<run>/prd/logs/evolution.md`   | Child candidate entries, evolution records, lineage, blockers, and champion summaries.                                   |
| `<run>/prd/PRD.md`              | Current champion after accepted promotion.                                                                               |
| `<run>/prd/GAPS.md`             | Active blocking product gap that a Challenger must resolve.                                                              |
| `<run>/STATE.md` Agent receipts | Harness-generated audit projection of spawn proof and acceptance status for Evolution, mutation, and championship roles. |

Each child should be discoverable from parent id, parent path, child id, child
path, trigger, operation, and lineage chain.

## Failure Modes

| Failure mode                                  | Risk                                                       | Mitigation                                                                 |
| --------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Evolution edits the parent in place           | Review and tournament evidence becomes unrecoverable.      | Always write a child candidate with a distinct path.                       |
| Evolution invents missing user intent         | The workflow silently chooses for the user.                | Route scope-defining gaps to the user.                                     |
| Evolution bypasses Reflection                 | Repaired drafts enter ranking without review.              | Treat every child as raw until Reflection approves it.                     |
| Combination bloats the PRD                    | The child accumulates every idea from every parent.        | Combine only compatible strengths tied to findings.                        |
| Simplification removes required scope         | The child becomes easy but wrong.                          | Preserve user-approved requirements unless the user changes them.          |
| Grounding repair adds unsupported constraints | Assumptions are treated as authoritative.                  | Distinguish hard constraints from conventions and assumptions.             |
| Divergent Evolution becomes new Generation    | Repair restarts exploration without bounds.                | Use divergent children only for repeated failures and run full Reflection. |
| Lineage is incomplete                         | Humans and agents cannot reconstruct why the child exists. | Require parent id, parent path, trigger, findings, and changed sections.   |

## Minimal Implementation

A minimal PRD Evolution implementation needs:

1. Trigger detection from Reflection, Tournament, Proximity, Meta-review, or
   user input.
2. Evolution input package builder.
3. Operation selector.
4. Child PRD writer with a distinct path.
5. Lineage fields on every child.
6. Evolution record.
7. Basic child artifact validation.
8. Re-entry into Reflection.
9. Repair budget enforcement.

It does not need raw PM draft generation, tournament matches, Reflection
execution inside Evolution, code mutation, technical design, or automatic
promotion.
