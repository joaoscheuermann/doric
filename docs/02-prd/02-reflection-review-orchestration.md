# Reflection Review Orchestration

This document defines Doric's Reflection review flow for PRD drafts. Reflection
is the quality gate between draft generation and candidate ranking: it reviews,
filters, and annotates PRD candidates before any tournament or promotion step.

Reflection is implementation-agnostic. It does not assume a specific package
layout, command surface, UI, language, runtime, or storage backend.

## Purpose

Reflection exists to falsify a candidate before Doric spends more work on it.
For the PRD phase, the candidate is a PRD draft: a product proposal that claims
to satisfy the accepted user request and to be ready for technical design.

The core question is:

```text
Does this PRD draft deserve to become a reviewed ranking candidate?
```

Reflection should catch these failures early:

- The draft solves the wrong user problem.
- The draft violates hard constraints or grounding.
- The draft is too vague to feed technical design.
- The draft hides important assumptions.
- The draft has weak or unverifiable acceptance criteria.
- The draft forces unnecessary architecture or workflow risk.
- The draft lacks a credible validation path.
- The draft depends on user decisions that have not been made.

Reflection does not implement, rank, or silently repair a draft. It produces
findings, review plans, eligibility decisions, and review evidence. Evolution
creates repaired child drafts when repair is appropriate.

## Core Flow

```text
PRD draft agents write multiple drafts
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
not the manually edited source of truth for whether a PRD candidate may advance.

## Invariants

- **Cheap first pass:** Initial Review is a fast gate and router.
- **Fixed review vocabulary:** Reviews must use known review step names.
- **Policy override:** Mandatory routing rules add coverage for known risks.
- **Independent evidence:** Split review steps only when they inspect different
  evidence or catch different failure modes.
- **No silent repair:** Reviewers report findings. They do not edit drafts.
- **Ranking eligibility:** Ranking compares reviewed drafts, not raw drafts.
- **Normalized findings:** All reviews return findings in a mergeable shape.
- **Harness authority:** Reflection outcomes inform harness transitions; they
  do not directly mutate canonical workflow state.
- **Human escalation:** If user intent, scope, or constraints are ambiguous,
  Reflection blocks for user input.

## Review Vocabulary

Reflection may route PRD drafts to these review steps:

| Review step                    | Main question                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Initial Review                 | Should this draft be discarded, blocked, or sent to deeper reviews?                                                        |
| Grounding Review               | Does the draft obey hard constraints and grounding evidence?                                                               |
| Product Alignment Review       | Does the draft solve the accepted request without scope drift?                                                             |
| Architecture Review            | Does the draft fit the existing architecture without unnecessary structural change?                                        |
| Behavior Review                | Is the proposed user-visible behavior coherent end to end?                                                                 |
| Simulation Review              | Does a step-by-step trace expose state, protocol, or control-flow gaps?                                                    |
| Validation Review              | Does the draft define enough proof to trust downstream work?                                                               |
| Risk Review                    | Does the draft introduce operational, workflow, data, or irreversible-action risk?                                         |
| Persistence Review             | Does the draft affect stored state, migration, replay, caches, or durability?                                              |
| Security Review                | Does the draft affect trust boundaries, secrets, auth, permissions, untrusted input, command execution, or network access? |
| Observability Review           | Will users or operators be able to see progress, failures, and recovery paths?                                             |
| Decomposition Readiness Review | Is the draft precise enough to feed technical design and implementation planning?                                          |
| Meta-review                    | What patterns across reviews should inform ranking, evolution, or future reviews?                                          |

## Initial Review

Initial Review is both a gatekeeper and a review planner. It reads the PRD
draft, accepted user request, current phase contract, grounding summary, and a
lightweight summary of affected workflows or system areas.

Initial Review should:

- Discard empty, incoherent, off-task, unsafe, or impossible drafts.
- Block for user input when the draft depends on an unresolved decision.
- Identify risk tags such as architecture impact, persistent state, security,
  tool execution, external integration, user-facing behavior, or broad scope.
- Recommend follow-up review steps from the fixed vocabulary.
- Explain why each recommended review is needed.

Initial Review must not approve risky drafts by itself, invent review names,
perform implementation review, repair drafts, or accept missing evidence because
the draft sounds plausible.

```text
function initial_review(draft, phase_contract, user_goal, grounding):
    if draft is empty:
        return discard("draft is empty")

    if draft does not address user_goal:
        return discard("draft does not solve the accepted user goal")

    if draft directly violates a known hard constraint:
        return discard("draft violates a hard constraint")

    if draft depends on a user decision that has not been made:
        return block("user input required before review can continue")

    reviews = [
        Product Alignment Review,
        Grounding Review,
        Validation Review,
        Decomposition Readiness Review
    ]

    add Architecture Review for structural changes or new boundaries
    add Behavior Review for user-visible behavior
    add Simulation Review for state transitions, protocols, async flow,
        retries, cancellation, streaming, event handling, or recovery
    add Persistence Review for stored state, config, caches, migrations,
        replayable records, generated artifacts, or durability
    add Security Review and Risk Review for trust boundaries, secrets, auth,
        shell execution, filesystem writes, network calls, external services,
        permissions, or untrusted input
    add Observability Review for logs, progress, errors, audit trails,
        monitoring, or operational visibility
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
function run_reflection(draft, phase_contract, run_state):
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

| Trigger                                                                                                          | Required reviews                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| PRD phase                                                                                                        | Product Alignment, Grounding, Validation, Decomposition Readiness |
| Structural or ownership change                                                                                   | Architecture                                                      |
| User-visible behavior change                                                                                     | Behavior                                                          |
| State transition, protocol, async flow, recovery, streaming, retry, cancellation, or event handling              | Simulation, Observability                                         |
| Persisted data, configuration, cache, migration, durable artifact, or replay                                     | Persistence                                                       |
| Trust boundary, auth, secret, shell, filesystem write, network, external service, permission, or untrusted input | Security, Risk                                                    |
| Multiple candidates or repeated review patterns                                                                  | Meta-review                                                       |

## Review Focus

Each review step has a bounded responsibility:

- **Grounding Review:** Check hard constraints, convention parameters,
  grounding evidence, and unresolved constraint conflicts.
- **Product Alignment Review:** Check direct coverage of the accepted request,
  success criteria, scope containment, open questions, and user workflows.
- **Architecture Review:** Check ownership, dependency direction, boundaries,
  structural necessity, documentation impact, and simpler alternatives.
- **Behavior Review:** Check user-visible workflow, success and failure states,
  terminology, commands, messages, and out-of-scope behavior preservation.
- **Simulation Review:** Trace the proposed flow step by step, including state
  changes, ownership, validation, failure, cancellation, retry, timeout, stale
  input, and partial completion.
- **Validation Review:** Check whether acceptance criteria are testable, named
  at the right level, backed by fallback evidence, and sufficient to prove key
  claims.
- **Risk Review:** Check data loss, overwritten work, destructive actions,
  irreversible effects, external dependencies, blast radius, rollback, and
  recovery.
- **Persistence Review:** Check stored state format, compatibility, migrations,
  restart behavior, durability, replay, recovery, and cleanup.
- **Security Review:** Check secrets, auth, permissions, untrusted input, shell
  exposure, path handling, web requests, file writes, redaction, least
  privilege, injection, leakage, and authorization risk.
- **Observability Review:** Check progress visibility, failure visibility,
  retry and cancellation status, recovery messages, audit evidence, and final
  handover evidence.
- **Decomposition Readiness Review:** Check requirement specificity,
  acceptance criteria, sequencing, dependencies, out-of-scope items, ownership,
  blockers, and implementation planning readiness.
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
- Evolution inputs.
- Ranking notes.

Review results should preserve disagreement. If Architecture Review approves a
draft but Validation Review blocks it, both results should remain visible. The
merge step decides the phase-level outcome.

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
    group duplicate findings by affected claim
    keep the highest severity for each duplicate group

    if any finding is fatal:
        return rejected

    if any finding blocks grounding, product alignment, validation,
       decomposition readiness, security, or architecture feasibility:
        return needs_evolution

    if findings are warnings only:
        return eligible_with_warnings

    return eligible
```

Severity guidance:

| Severity   | Meaning                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fatal`    | Violates a hard constraint, contradicts accepted scope, requires unsafe action without approval, or cannot be repaired without restarting the phase. |
| `blocking` | Likely grounding, alignment, architecture, validation, security, behavior, or decomposition failure that can be repaired by Evolution.               |
| `warning`  | Convention deviation, minor ambiguity, or residual risk that should be recorded but does not block ranking eligibility.                              |
| `note`     | Useful observation for Ranking, Evolution, or Handover.                                                                                              |

## Ranking And Evolution Loop

```text
function reflect_prd_drafts(drafts, user_goal, grounding, run_state):
    reviewed_candidates = []
    repairable_candidates = []

    for each draft in drafts:
        outcome = run_reflection(draft, PRD phase, run_state)

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

    if champion passes the zero-gap product gate:
        promote champion as the accepted PRD
    else:
        write <run>/prd/GAPS.md and route repairable gaps to Evolution
```

The ranking judge compares both PRD content and review evidence. A fluent draft
with weak validation should lose to a less polished draft that is more
grounded, more testable, and easier to decompose.

Reflection eligibility is necessary but not sufficient for Doric promotion. The
accepted PRD must also clear the product gap gate: direct coverage, scope
containment, constraint consistency, non-functional feasibility, and implicit
dependency checks. If that gate fails, the champion remains a candidate and the
blocking gap belongs in the PRD gap report at `<run>/prd/GAPS.md`.

## Evolution Contract

Evolution is a repair and refinement step. It does not replace missing user
input, Reflection, or ranking eligibility rules.

Use Evolution when Reflection finds repairable gaps, a ranking champion has
repairable warnings, or review evidence identifies a focused change that can
produce a stronger child candidate.

Do not use Evolution when Initial Review blocks for a user decision, a draft
violates a fatal hard constraint, or the repair would silently change accepted
requirements or scope.

Every evolved PRD draft is a child candidate. It must carry enough lineage to
reconstruct where it came from, why it exists, and which review or ranking
evidence caused the repair.

Evolution input should include:

- Parent candidate ID, title, path, generation source, and review evidence.
- Trigger, triggering findings, and ranking notes.
- Current grounding snapshot.
- Allowed change scope.
- Requirements and decisions that must be preserved.
- Lineage chain.

Evolution output should include:

- New candidate ID, title, and path.
- Direct parent ID and path.
- Evolution trigger.
- Addressed findings.
- Requirements preserved from the parent.
- Sections, claims, or acceptance criteria changed from the parent.
- Updated lineage chain.

The child draft must not overwrite the parent path. The parent remains a
historical candidate with its own review and ranking evidence. The child is a
raw candidate until Reflection reviews it.

Evolution re-entry invariant:

```text
Only Reflection-reviewed PRD candidates can enter ranking.
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

The first implementation should target PRD draft Reflection only.

Start with:

1. Initial Review.
2. Grounding Review.
3. Product Alignment Review.
4. Validation Review.
5. Decomposition Readiness Review.
6. Architecture Review only when structural changes are proposed.

Add Simulation, Risk, Security, Persistence, Observability, and Meta-review only
when the draft triggers their routing rules.

This gives Doric adaptive Reflection without turning every PRD review into a
fixed review committee.
