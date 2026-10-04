# TDD Reflection Review Orchestration

This document defines Doric's Reflection review flow for TDD drafts. Reflection
is the quality gate between technical draft generation and candidate ranking:
it reviews, filters, and annotates TDD candidates before any tournament or
promotion step.

Reflection is implementation-aware but mutation-free. It may inspect current
source, manifests, schemas, tests, and architecture documents to verify design
claims, but it does not edit code or repair drafts in place.

## Purpose

Reflection exists to falsify a candidate before Doric spends more work on it.
For the technical-design phase, the candidate is a TDD draft: a technical
proposal that claims to satisfy the accepted PRD and to be ready for
decomposition.

The core question is:

```text
Does this TDD draft deserve to become a reviewed ranking candidate?
```

Reflection should catch these failures early:

- The draft does not cover a major PRD requirement.
- The draft violates hard constraints or repository grounding.
- The draft contradicts current architecture, package ownership, or dependency
  direction.
- The draft invents unsupported repository facts.
- The draft hides important technical assumptions.
- The draft has missing, vague, or unverifiable Dependency Hops.
- The draft depends on deprecated, unavailable, or invalid libraries.
- The draft lacks credible test seams or validation evidence.
- The draft introduces security, persistence, migration, or operational risk
  without mitigation.
- The draft is too vague to feed decomposition.
- The draft depends on user architecture decisions that have not been made.

Reflection does not implement, rank, or silently repair a draft. It produces
findings, review plans, eligibility decisions, and review evidence. Evolution
creates repaired child drafts when repair is appropriate.

## Core Flow

```text
TDD draft agents write multiple drafts
  -> each raw draft enters Reflection
  -> Initial Review gates and plans deeper review
  -> Supervisor applies mandatory routing policy
  -> selected review steps run with bounded evidence
  -> findings are merged and deduplicated
  -> rejected, blocked, needs evolution, or eligible
  -> only eligible reviewed candidates enter ranking
  -> repairable child drafts re-enter Reflection before ranking
```

Initial Review recommends the review path, but it is not final authority. The
Supervisor must add mandatory reviews from deterministic policy before any
review sub-agent or review routine runs.

Raw drafts and evolved-but-unreviewed drafts must not enter ranking.

## Workflow State Authority

In the target architecture, Reflection produces review evidence and phase
outcome recommendations, but the workflow state harness owns canonical
transition state. Blocking outcomes, user-input waits, ranking eligibility, and
promotion readiness are recorded through the harness and projected into
`STATE.md` as a human-readable audit ledger.

`STATE.md` is therefore a visibility and review surface for humans and agents,
not the manually edited source of truth for whether a TDD candidate may advance.

## Invariants

- **Cheap first pass:** Initial Review is a fast gate and router.
- **Fixed review vocabulary:** Reviews must use known review step names.
- **Policy override:** Mandatory routing rules add coverage for known risks.
- **Evidence-backed claims:** Current-code claims require repository evidence.
- **Independent evidence:** Split review steps only when they inspect different
  evidence or catch different failure modes.
- **No silent repair:** Reviewers report findings. They do not edit drafts.
- **Ranking eligibility:** Ranking compares reviewed drafts, not raw drafts.
- **Normalized findings:** All reviews return findings in a mergeable shape.
- **Harness authority:** Reflection outcomes inform harness transitions; they
  do not directly mutate canonical workflow state.
- **Human escalation:** If product scope, irreversible architecture choices, or
  constraints are ambiguous, Reflection blocks for user input.

## Review Vocabulary

Reflection may route TDD drafts to these review steps:

| Review step                       | Main question                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Initial Review                    | Should this draft be discarded, blocked, or sent to deeper reviews?                                                                      |
| Grounding Review                  | Does the draft obey hard constraints and grounding evidence?                                                                             |
| PRD Traceability Review           | Does every major PRD requirement have a technical path without product-scope drift?                                                      |
| Architecture Fit Review           | Does the draft fit current package ownership, dependency direction, boundaries, and repo patterns?                                       |
| Dependency Hop Review             | Are Dependency Hops concrete, evidence-backed, falsifiable, and paired with fallbacks or blocking questions?                             |
| Interface Contract Review         | Are APIs, commands, events, tools, schemas, or UI states explicit enough to implement and test?                                          |
| Data And Persistence Review       | Does the draft handle stored state, migrations, durability, replay, cleanup, and compatibility?                                          |
| Simulation Review                 | Does a step-by-step trace expose state, protocol, async, cancellation, retry, or recovery gaps?                                          |
| Security Review                   | Does the draft handle trust boundaries, secrets, auth, permissions, command execution, file writes, network access, and untrusted input? |
| Performance And Operations Review | Does the draft handle latency, concurrency, scaling, resource use, observability, failure, and recovery?                                 |
| Testing Review                    | Does the draft define enough proof to trust downstream implementation?                                                                   |
| Rollout And Migration Review      | Can the design ship incrementally without unsafe compatibility or data risks?                                                            |
| Decomposition Readiness Review    | Is the draft precise enough to produce ordered effort files?                                                                             |
| Meta-review                       | What patterns across reviews should inform ranking, evolution, or future reviews?                                                        |

## Initial Review

Initial Review is both a gatekeeper and a review planner. It reads the TDD
draft, accepted PRD, architecture-scoped prompt constraints, current phase
contract, grounding summary, and a lightweight summary of affected repository
areas.

Initial Review should:

- Discard empty, incoherent, off-task, unsafe, or impossible drafts.
- Block for user input when the draft depends on an unresolved product or
  architecture decision.
- Identify risk tags such as package-boundary impact, persistent state,
  security, tool execution, external integration, generated contracts,
  user-facing behavior, or broad migration.
- Recommend follow-up review steps from the fixed vocabulary.
- Explain why each recommended review is needed.

Initial Review must not approve risky drafts by itself, invent review names,
perform implementation work, repair drafts, or accept missing evidence because
the draft sounds plausible.

```text
function initial_review(draft, phase_contract, accepted_prd, grounding):
    if draft is empty:
        return discard("draft is empty")

    if draft does not cover accepted_prd major requirements:
        return discard("draft does not satisfy the accepted PRD")

    if draft directly violates a known hard constraint:
        return discard("draft violates a hard constraint")

    if draft depends on a user decision that has not been made:
        return block("user input required before review can continue")

    reviews = [
        PRD Traceability Review,
        Grounding Review,
        Architecture Fit Review,
        Dependency Hop Review,
        Testing Review,
        Decomposition Readiness Review
    ]

    add Interface Contract Review for API, command, event, tool, schema, or UI changes
    add Data And Persistence Review for stored state, config, caches, migrations,
        replayable records, generated artifacts, or durability
    add Simulation Review for state transitions, protocols, async flow,
        retries, cancellation, streaming, event handling, or recovery
    add Security Review for trust boundaries, secrets, auth, shell execution,
        filesystem writes, network calls, external services, permissions,
        or untrusted input
    add Performance And Operations Review for latency, concurrency, scale,
        resource use, observability, or operational recovery
    add Rollout And Migration Review for compatibility, staged rollout,
        migration, or backward-compatibility concerns
    add Meta-review when there are competing candidates or repeated patterns

    return continue_with(reviews)
```

## Supervisor Routing

The Supervisor uses Initial Review as advice, then applies mandatory routing
rules. This keeps review routing adaptive while still enforcing coverage for
known risk categories. The Supervisor records outcomes through the workflow
state harness so `STATE.md` is regenerated as the audit projection.

Keep these names distinct:

- `reviews` is the ordered review plan.
- `review_results` is the evidence produced by completed reviews.
- `merge_review_results` reduces many review outputs into one Reflection
  decision.

Each review plan item should define the review name, trigger, evidence inputs,
review focus, blocking criteria, and expected output.

```text
function run_tdd_reflection(draft, phase_contract, run_state):
    initial = run_initial_review(draft, phase_contract, run_state)

    if initial says discard:
        record discard decision
        return rejected

    if initial says block:
        request user input
        return waiting

    selected_reviews = reviews recommended by initial
    selected_reviews += reviews_required_by_policy(draft, phase_contract, run_state)
    selected_reviews = remove duplicates
    selected_reviews = remove reviews already satisfied by accepted evidence

    review_results = []
    for each review in selected_reviews:
        result = run review with narrow instructions and explicit evidence inputs
        review_results.add(result)

    return merge_review_results(review_results)
```

Mandatory routing rules:

| Trigger                                                                                                          | Required reviews                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Technical-design phase                                                                                           | PRD Traceability, Grounding, Architecture Fit, Dependency Hop, Testing, Decomposition Readiness |
| Package ownership or dependency change                                                                           | Architecture Fit                                                                                |
| API, command, event, tool, schema, or UI-state change                                                            | Interface Contract, Testing                                                                     |
| State transition, protocol, async flow, recovery, streaming, retry, cancellation, or event handling              | Simulation, Performance And Operations                                                          |
| Persisted data, configuration, cache, migration, durable artifact, generated contract, or replay                 | Data And Persistence, Rollout And Migration                                                     |
| Trust boundary, auth, secret, shell, filesystem write, network, external service, permission, or untrusted input | Security                                                                                        |
| Performance, concurrency, resource, observability, daemon, worker, or operational behavior change                | Performance And Operations                                                                      |
| Multiple candidates or repeated review patterns                                                                  | Meta-review                                                                                     |

## Review Focus

Each review step has a bounded responsibility:

- **Grounding Review:** Check hard constraints, convention parameters,
  grounding evidence, and unresolved constraint conflicts.
- **PRD Traceability Review:** Check direct coverage of accepted PRD
  requirements, non-goals, acceptance criteria, and user-visible behavior.
- **Architecture Fit Review:** Check package ownership, dependency direction,
  boundaries, structural necessity, simpler alternatives, and documentation
  impact.
- **Dependency Hop Review:** Verify each design assumption against a package,
  API, schema, platform capability, operational condition, evidence source,
  failure mode, and fallback.
- **Interface Contract Review:** Check API, command, event, tool, schema, or UI
  contracts for implementability, versioning, compatibility, and testability.
- **Data And Persistence Review:** Check stored state format, compatibility,
  migrations, restart behavior, durability, replay, recovery, and cleanup.
- **Simulation Review:** Trace the proposed flow step by step, including state
  changes, ownership, validation, failure, cancellation, retry, timeout, stale
  input, and partial completion.
- **Security Review:** Check secrets, auth, permissions, untrusted input, shell
  exposure, path handling, web requests, file writes, redaction, least
  privilege, injection, leakage, and authorization risk.
- **Performance And Operations Review:** Check latency, throughput,
  concurrency, memory, backpressure, logs, progress, error reporting, recovery,
  and operator visibility.
- **Testing Review:** Check whether proof is named at the right level, backed
  by existing tooling, narrow enough for efforts, and sufficient for key
  claims.
- **Rollout And Migration Review:** Check compatibility, staged rollout,
  migration sequencing, fallback, cleanup, and rollback risk.
- **Decomposition Readiness Review:** Check requirement specificity, effort
  boundaries, sequencing, dependencies, blockers, ownership, and validation
  handoff.
- **Meta-review:** Summarize recurring findings, reviewer disagreement,
  candidate-level patterns, ranking implications, and compact Evolution inputs.

## Review Results

Each review result should include:

- Review name.
- Verdict: `eligible`, `eligible_with_warnings`, `needs_evolution`,
  `rejected`, or `blocked`.
- Findings.
- Verified claims.
- Unverified claims.
- Dependency Hops accepted, rejected, or requiring repair.
- Evolution inputs.
- Ranking notes.

Review results should preserve disagreement. If Architecture Fit Review
approves a draft but Dependency Hop Review blocks it, both results should
remain visible. The merge step decides the phase-level outcome.

## Merging Review Results

The Supervisor owns merge behavior. Individual reviewers should not decide the
phase outcome alone unless they found a fatal hard-constraint violation.

`merge_review_results` deduplicates findings, preserves important
disagreement, assigns final severity, and returns one phase-level outcome:

```text
rejected:
    Draft cannot continue.

needs_evolution:
    Draft is useful but must be repaired before ranking eligibility.

eligible_with_warnings:
    Draft can enter ranking, but warnings must remain visible.

eligible:
    Draft can enter ranking with no blocking findings.
```

```text
function merge_review_results(results):
    collect all findings
    group duplicate findings by affected claim or Dependency Hop
    keep the highest severity for each duplicate group

    if any finding is fatal:
        return rejected

    if any finding blocks PRD traceability, grounding, architecture fit,
       Dependency Hops, security, testing, or decomposition readiness:
        return needs_evolution

    if findings are warnings only:
        return eligible_with_warnings

    return eligible
```

Severity guidance:

| Severity   | Meaning                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fatal`    | Violates a hard constraint, contradicts accepted PRD scope, requires unsafe action without approval, or cannot be repaired without restarting the phase. |
| `blocking` | Likely grounding, architecture, dependency, validation, security, behavior, or decomposition failure that can be repaired by Evolution.                  |
| `warning`  | Convention deviation, minor ambiguity, or residual risk that should be recorded but does not block ranking eligibility.                                  |
| `note`     | Useful observation for Ranking, Evolution, Decomposition, or Handover.                                                                                   |

## Ranking And Evolution Loop

```text
function reflect_tdd_drafts(drafts, accepted_prd, grounding, run_state):
    reviewed_candidates = []
    repairable_candidates = []

    for each draft in drafts:
        outcome = run_reflection(draft, technical-design phase, run_state)

        if outcome is rejected:
            record rejected draft
            continue

        if outcome is waiting:
            request user input
            continue

        if outcome needs evolution:
            record repairable draft
            repairable_candidates.add(draft)
            continue

        attach review evidence to draft
        reviewed_candidates.add(draft)

    if reviewed_candidates is empty:
        evolve the best repairable candidate if one exists
        send the child draft back through Reflection
        otherwise block for user input or fail the phase

    tournament = run_elo_tournament(reviewed_candidates)
    champion = tournament.highest_ranked_candidate

    if champion has repairable warnings that should be fixed:
        evolve the champion
        send the child draft back through Reflection

    if champion passes the zero-gap technical gate:
        promote champion as the accepted TDD
    else:
        write <run>/tdd/GAPS.md and route repairable gaps to Evolution
```

The ranking judge compares both TDD content and review evidence. A fluent draft
with weak Dependency Hops should lose to a less polished draft that is more
grounded, more testable, and easier to decompose.

Reflection eligibility is necessary but not sufficient for Doric promotion. The
accepted TDD must also clear the technical gap gate: PRD traceability,
architecture fit, Dependency Hop validity, testability, security and operations
risk, and decomposition readiness. If that gate fails, the champion remains a
candidate and the blocking gap belongs in `<run>/tdd/GAPS.md`.

`<run>/tdd/GAPS.md` is the TDD analogue of the PRD gap report at
`<run>/prd/GAPS.md`. It records active blocking technical gaps for the current
champion so Evolution has concrete repair evidence; routine notes, duplicate
comments, and findings from rejected drafts stay in review evidence unless they
block promotion.

## Evolution Contract

Evolution is a repair and refinement step. It does not replace missing user
input, Reflection, or ranking eligibility rules.

Use Evolution when Reflection finds repairable gaps, a ranking champion has
repairable warnings, or review evidence identifies a focused change that can
produce a stronger child candidate.

Do not use Evolution when Initial Review blocks for a user decision, a draft
violates a fatal hard constraint, or the repair would silently change accepted
PRD requirements or repository architecture constraints.

Every evolved TDD draft is a child candidate. It must carry enough lineage to
reconstruct where it came from, why it exists, and which review or ranking
evidence caused the repair.

Evolution input should include:

- Parent candidate ID, title, path, generation source, and review evidence.
- Trigger, triggering findings, ranking notes, and affected Dependency Hops.
- Current grounding snapshot.
- Accepted PRD snapshot.
- Relevant repository evidence.
- Allowed change scope.
- Requirements, architecture constraints, and decisions that must be preserved.
- Lineage chain.

Evolution output should include:

- New candidate ID, title, and path.
- Direct parent ID and path.
- Evolution trigger.
- Addressed findings and Dependency Hops.
- Requirements preserved from the parent.
- Sections, claims, interfaces, or tests changed from the parent.
- Updated lineage chain.

The child draft must not overwrite the parent path. The parent remains a
historical candidate with its own review and ranking evidence. The child is a
raw candidate until Reflection reviews it.

Evolution re-entry invariant:

```text
Only Reflection-reviewed TDD candidates can enter ranking.
Evolution never promotes a draft directly.
Evolution always creates a new child candidate with lineage.
The child candidate must pass Reflection before ranking or promotion.
```

The second Reflection pass may be narrower when the repair is local and the
changed sections are clear:

```text
if evolved draft changed only the flagged sections:
    run Initial Review
    rerun the review steps that produced blocking findings
    rerun any review whose assumptions may be affected
else:
    run full Reflection again
```

Keep repair cycles bounded. A practical default is one Evolution attempt per
Reflection cycle. If the child draft still fails, the Supervisor can reject it,
ask for user input, or permit another repair cycle under an explicit budget.

## Minimal First Implementation

The first implementation should target TDD draft Reflection only.

Start with:

1. Initial Review.
2. Grounding Review.
3. PRD Traceability Review.
4. Architecture Fit Review.
5. Dependency Hop Review.
6. Testing Review.
7. Decomposition Readiness Review.

Add Interface Contract, Data And Persistence, Simulation, Security,
Performance And Operations, Rollout And Migration, and Meta-review only when
the draft triggers their routing rules.

This gives Doric adaptive Reflection without turning every technical design
review into a fixed review committee.
