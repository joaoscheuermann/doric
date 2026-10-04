# TDD Tournament Grounding Architecture

This document defines Doric's TDD tournament phase. The tournament ranks
Reflection-reviewed TDD candidates and recommends the strongest candidate for
Evolution, promotion to `<run>/tdd/TDD.md`, or a human decision.

The tournament is not a writing phase. It does not generate TDDs, repair
drafts, implement code, or override review gates. It compares reviewed
candidates using shared grounding, Proximity evidence, Reflection findings, and
stable technical criteria.

## Core Concepts

| Concept                 | Meaning                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate               | A TDD draft that passed Reflection as `eligible` or `eligible_with_warnings`.                                                                  |
| Grounding               | The hard constraints, conventions, accepted prompt artifacts, accepted PRD, repository evidence, and human-gate decisions that govern the run. |
| Proximity evidence      | Cluster and similarity information used to choose useful candidate matchups.                                                                   |
| Reflection evidence     | Review verdicts, warnings, rationale, Dependency Hop findings, and decomposition-readiness notes attached to each candidate.                   |
| Match                   | A pairwise comparison between two candidates.                                                                                                  |
| Rating                  | A relative score updated after each match. New candidates start at `1200` unless a runtime has a calibrated alternative.                       |
| Champion recommendation | The highest-ranked eligible candidate plus the rationale and promotion decision.                                                               |
| Workflow state harness  | Target architecture component that owns canonical promotion, blocked, and handoff transitions after tournament evidence is produced.           |
| `STATE.md` projection   | Generated human-readable audit ledger of harness state, including tournament receipts and promotion visibility.                                |

Ratings help order candidates, but they do not prove correctness. A candidate
must pass promotion gates before it can become the accepted TDD.

## Phase Position

```text
Prompt Ingestion
  -> PRD Evolution and Promotion
  -> TDD Generation
  -> Proximity Filtering
  -> Reflection
  -> TDD Tournament
  -> Champion Recommendation
```

The tournament admits only Reflection-reviewed candidates. It must reject raw
drafts, malformed outputs, Reflection-rejected drafts, blocked drafts, and
evolved child drafts that have not re-entered Reflection.

The tournament is a relative ranking phase. It is not a substitute for
Reflection, Grounding Review, Dependency Hop verification, or human approval.

## Workflow State Authority

Tournament records are evidence for the workflow state harness. Ratings,
match outcomes, and champion recommendations do not directly advance the run;
the harness owns canonical transition decisions and checks promotion gates,
required-agent proof, and human-gate status.

`STATE.md` is the generated projection of that canonical state. It remains
durable and reviewable for agents and humans, but it is not the manually edited
source of truth for TDD promotion.

## Purpose

The tournament answers:

```text
Among the TDD candidates that survived Reflection, which candidate is the
strongest basis for decomposition?
```

It should identify which candidate best:

- Satisfies the accepted PRD without product-scope drift.
- Handles hard constraints safely.
- Fits current architecture, package ownership, and dependency direction.
- Defines explicit API, command, event, data, or interface contracts when
  needed.
- Exposes technical assumptions through concrete Dependency Hops.
- Gives downstream agents a credible validation path.
- Can be decomposed into ordered efforts without guesswork.
- Avoids unnecessary architecture, workflow, data, migration, and security
  risk.
- Preserves useful losing concepts for Evolution when appropriate.

The tournament must not invent missing user intent, hide Reflection warnings,
repair candidates directly, or promote a candidate with blocking findings.

## Grounding Authority

Doric ranking uses two levels of grounding:

- Hard constraints are non-negotiable gates.
- Convention parameters are preferred defaults that can be deviated from only
  with clear justification.

Tournament authority order:

1. System and runtime safety requirements.
2. Repository and workflow grounding documents.
3. User-approved hard constraints for the current run.
4. Reflection verdicts and blocking findings.
5. Accepted `<run>/prd/PRD.md` and architecture-scoped prompt constraints.
6. Current repository evidence.
7. Proximity evidence.
8. Convention parameters.
9. Pairwise judge preference.

A candidate that violates a hard constraint cannot win a match or become
champion. Convention deviations are allowed only when the candidate explains
why the deviation improves the TDD without weakening the run constraints.

## Inputs

Each candidate should carry:

- Candidate id and draft path.
- Parent candidate id, if evolved.
- Architect lens or generation origin.
- Proximity cluster.
- Reflection verdict, findings, warnings, and rationale.
- Dependency Hops and review status.
- Grounding notes and assumptions.
- PRD requirement mapping.
- Technical contracts and validation expectations.

The tournament also receives:

- Proximity clusters, near-duplicate notes, and cross-cluster strategy signals.
- The grounding bundle used by Generation and Reflection.
- The accepted `<run>/prd/PRD.md`.
- Current repository evidence needed by match judges.
- Any human-gate decisions already made for the run.

The judge should mention grounding only when it changes the match decision.

## Eligibility Gate

The Tournament Supervisor checks eligibility before seeding ratings.

```text
function tournament_eligible(candidate):
    if candidate has no Reflection record:
        return false
    if candidate.reflection_verdict is rejected:
        return false
    if candidate.reflection_verdict is blocked:
        return false
    if candidate.reflection_verdict is needs_evolution:
        return false
    if candidate violates a hard constraint:
        return false
    if candidate has unresolved blocking Dependency Hops:
        return false
    if candidate is an evolved child draft not yet reviewed:
        return false
    return candidate is eligible or eligible_with_warnings
```

Warnings are allowed only when Reflection marked them as non-blocking. The judge
must still account for them in relevant matches.

## Tournament Flow

```text
Reflection-reviewed TDD candidates
  |
  v
Check eligibility
  |
  v
Seed ratings and candidate registry
  |
  v
Build match queue from Proximity and Reflection evidence
  |
  v
Run pairwise matches
  |
  +-- single-turn comparison for weak, obvious, or low-risk matches
  +-- multi-turn debate for top, close, risky, or high-impact matches
  |
  v
Update ratings and write match records
  |
  v
Repeat until confidence, budget, stability, or gate stop condition
  |
  v
Recommend champion, Evolution, more generation, or blocked outcome
```

If only one candidate survives Reflection, Doric should not pretend a
tournament happened. It may promote the candidate if gates pass, send it to
Evolution if warnings are repairable, ask the user whether to generate more
candidates, or return to TDD Generation if diversity was expected but failed.

## Match Scheduling

Build the match queue to maximize useful information:

1. Compare candidates within the same Proximity cluster.
2. Compare candidates with similar ratings.
3. Compare the current leader against the strongest distinct challenger.
4. Give newly eligible candidates enough matches to calibrate.
5. Compare high-warning candidates against lower-warning alternatives.
6. Run cross-cluster matches when multiple technical strategies survive.
7. Stop matching clearly dominated candidates unless Doric needs an explicit
   loss rationale.

This avoids wasting matches on duplicates while still testing materially
different technical strategies.

## Match Types

Use a single-turn match when the outcome is likely obvious, the candidates are
not close, the match is only for calibration, or the budget is tight.

Use a multi-turn debate when both candidates are top-ranked, ratings are close,
the candidates represent different strategies, Reflection warnings matter, or
the winner will likely become champion.

For multi-turn debates, use four roles:

- Candidate A advocate.
- Candidate B advocate.
- Grounding and Reflection critic.
- Final judge.

The critic checks hard constraints, warnings, assumptions, Dependency Hops, and
validation gaps. The judge decides which TDD is stronger for downstream
decomposition.

## Judge Criteria

The pairwise judge compares candidates against:

| Criterion                  | Question                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| PRD traceability           | Which candidate better satisfies the accepted PRD without scope drift?                                                             |
| Hard constraints           | Does either candidate violate a non-negotiable constraint?                                                                         |
| Architecture fit           | Which candidate better respects package ownership, dependency direction, and current boundaries?                                   |
| Grounding quality          | Which candidate better applies run grounding and repository evidence?                                                              |
| Dependency Hops            | Which candidate exposes assumptions with stronger evidence, fallbacks, and failure modes?                                          |
| Interface clarity          | Which candidate defines clearer API, command, event, data, tool, or UI contracts?                                                  |
| Validation readiness       | Which candidate gives downstream agents a stronger proof path?                                                                     |
| Decomposition readiness    | Which candidate can produce ordered efforts without guesswork?                                                                     |
| Security and privacy       | Which candidate handles trust boundaries, secrets, auth, permissions, command execution, network access, and data exposure better? |
| Performance and operations | Which candidate handles latency, concurrency, observability, failure, recovery, and resource use better?                           |
| Migration and rollout      | Which candidate can ship with less compatibility, migration, and rollback risk?                                                    |
| Simplicity                 | Which candidate solves the problem with less unnecessary structure?                                                                |
| Reflection evidence        | Which candidate has fewer or less severe remaining warnings?                                                                       |

The judge should not reward more prose, bigger architecture, premature
implementation detail, unsupported current-code claims, aesthetic polish
without clearer contracts, unjustified convention deviations, or ignored
Reflection evidence.

## Rating Update

The tournament can use standard Elo-style updates:

```text
expected_a = 1 / (1 + 10 ^ ((rating_b - rating_a) / 400))
expected_b = 1 / (1 + 10 ^ ((rating_a - rating_b) / 400))

rating_a = rating_a + k * (score_a - expected_a)
rating_b = rating_b + k * (score_b - expected_b)
```

Scores are `1.0` for a win, `0.0` for a loss, and `0.5` for an effective tie.
`K = 32` is a reasonable default, but implementations should make it
configurable because candidate count, match count, and judge stability affect
rating volatility.

## Match Records

Each match record should include:

- Candidate A and Candidate B.
- Match type.
- Evidence used.
- Winner and confidence.
- Main reasons.
- Hard-constraint checks.
- Reflection findings that affected the decision.
- Dependency Hops that affected the decision.
- Useful losing concepts.
- Notes for Evolution or Meta-review.
- Rating update.

A rating without reasons is not enough to promote a TDD.

## Champion Recommendation

The final output is a recommendation, not unconditional promotion. It should
state:

- Champion candidate id and path.
- Why it won.
- Which candidates it beat.
- Which criteria drove the result.
- Remaining warnings.
- Whether it can be promoted directly.
- Whether it should go to Evolution first.
- Whether human approval is needed.

The final champion is the highest-ranked eligible candidate that passes all
promotion gates. Ratings identify the leader; gates decide whether that leader
is safe enough to become the accepted technical design.

## Promotion Gates

A champion TDD can be promoted to `<run>/tdd/TDD.md` only when:

- It is Reflection-reviewed.
- It has no blocking findings.
- It does not violate hard constraints.
- Its remaining warnings are acceptable or explicitly deferred.
- The tournament record explains why it beat alternatives.
- Required human gates before TDD generation are satisfied.
- Every major PRD requirement has a technical path.
- Every active Dependency Hop is verified, mitigated, or converted into a
  blocking question.

For the Doric TDD Evolution Engine, promotion also requires a zero-gap
technical gate:

- The latest champion version is the artifact written to `<run>/tdd/TDD.md`.
- The champion passes PRD Traceability, Architecture Fit, Dependency Hop
  Validity, Interface Contract, Testability, Security And Operations, and
  Decomposition Readiness checks.
- `<run>/tdd/GAPS.md` is absent, empty of active blocking gaps, or
  explicitly marked superseded by the current champion.
- Accepted child-agent evidence exists for generation, proximity filtering,
  tournament evaluation when applicable, concept grafting, gap analysis,
  mutation when applicable, and championship comparison when applicable.
- Remaining open questions are recorded as non-blocking for decomposition.

Promotion means:

```text
Champion reviewed TDD -> accepted TDD -> user approval request for decomposition
```

Promotion does not mean decomposition may begin. The coordinator must present
the finalized `<run>/tdd/TDD.md` summary, obtain explicit user approval, record
`tdd_to_decomposition` in `<run>/STATE.md`, and only then advance to
decomposition.

## Outcome Handoffs

Evolution is appropriate when the champion is strongest but repairable, a
losing concept should be grafted into the champion, or the tournament exposes a
recurring weakness in architecture fit, Dependency Hops, validation,
decomposition readiness, or risk treatment. The evolved child must re-enter
Reflection before it can enter a new tournament or be promoted.

Meta-review is appropriate when Doric needs a compact pattern summary for
future runs. It should capture common win/loss reasons, repeated grounding
failures, weak Dependency Hops, weak test strategies, architecture diversity
gaps, and criteria that were hard for judges to apply. Meta-review should not
rewrite the champion.

## Stop Rules

The tournament stops when one condition is met:

| Stop condition                 | Meaning                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| Champion confidence reached    | The leader has enough wins against relevant challengers.              |
| Match budget exhausted         | The configured compute budget is spent.                               |
| Rating stability reached       | Additional matches are unlikely to change the leader.                 |
| Hard-constraint conflict found | A candidate or the whole set is blocked by grounding.                 |
| Blocking Dependency Hop found  | The current leader depends on an unverified or impossible assumption. |
| No safe champion               | All candidates have blocking issues or unresolved user dependencies.  |
| Human gate required            | The next decision depends on user judgment.                           |

`best_under_budget` is a reportable tournament outcome, not an accepted TDD. It
can feed a user decision, another generation round, or a narrower prompt, but
it must not advance to decomposition unless promotion gates and
`tdd_to_decomposition` approval pass.

## Artifact Contract

A generic implementation should persist:

| Artifact                               | Purpose                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `<run>/tdd/logs/tournament_evals.json` | Candidate registry, pairwise outcomes, ratings, and final ranking.                                     |
| `<run>/tdd/logs/evolution.md`          | Human-readable tournament summary, champion rationale, lineage, and residual risk.                     |
| `<run>/tdd/TDD.md`                     | Accepted zero-gap champion after promotion.                                                            |
| `<run>/tdd/GAPS.md`                    | Active technical gap when the champion is not yet promotable.                                          |
| `<run>/STATE.md` Agent receipts        | Harness-generated audit projection of spawn proof and acceptance status for tournament evaluator work. |

The harness may maintain machine-readable canonical state, but the
human-readable projection is required because TDD selection affects
decomposition and implementation order.

`<run>/tdd/GAPS.md` should only describe active technical blockers for the
current champion or Challenger path. Non-blocking warnings can remain in
tournament, Reflection, or Evolution evidence unless the promotion gate depends
on them.

## Failure Modes

| Failure mode                           | Mitigation                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Raw drafts enter the tournament.       | Admit only Reflection-reviewed candidates.                              |
| Rating hides hard-constraint failures. | Treat hard constraints as eligibility gates and match losses.           |
| Judge rewards complexity or novelty.   | Use stable criteria and concise match rationales.                       |
| Proximity is ignored.                  | Build match queues from Proximity clusters.                             |
| Reflection evidence is ignored.        | Attach Reflection findings to every match prompt.                       |
| Dependency Hops are ignored.           | Treat unverified or impossible hops as eligibility failures.            |
| Champion has unresolved warnings.      | Promote only clean champions or send repairable champions to Evolution. |
| Too many matches run.                  | Use budgets, single-turn matches, and confidence stop rules.            |
| Too few matches run.                   | Require relevant wins against similar and distinct challengers.         |

## Minimal Implementation

A minimal TDD tournament needs:

1. Candidate eligibility check based on Reflection.
2. Initial rating for eligible candidates.
3. Match queue built from Proximity and Reflection evidence.
4. Pairwise judge prompt for single-turn comparisons.
5. Optional multi-turn debate for top or close candidates.
6. Rating update logic.
7. Match records with rationale.
8. Champion recommendation.
9. Promotion, Evolution, or blocked outcome.

It does not need new TDD generation, Reflection execution, code mutation,
decomposition generation, or automatic Evolution inside a match.

## Summary

The TDD tournament is Doric's ranking phase for Reflection-reviewed technical
design candidates. It uses ratings to track pairwise outcomes, Proximity to
choose useful matches, Reflection evidence to keep comparisons grounded, and
hard constraints as gates.

The output is a champion TDD recommendation with an auditable tournament
record. A clean champion can be submitted to the harness for promotion to
`<run>/tdd/TDD.md`, but decomposition still requires explicit
`tdd_to_decomposition` approval. A repairable champion should go to Evolution,
which creates a child TDD that must pass Reflection again before it can be
ranked or promoted.
