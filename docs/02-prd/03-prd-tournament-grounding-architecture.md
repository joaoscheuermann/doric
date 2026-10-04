# PRD Tournament Grounding Architecture

This document defines Doric's PRD tournament phase. The tournament ranks
Reflection-reviewed PRD candidates and recommends the strongest candidate for
technical design, Evolution, or a human decision.

The tournament is not a writing phase. It does not generate PRDs, repair drafts,
or override review gates. It compares reviewed candidates using shared
grounding, Proximity evidence, Reflection findings, and stable product criteria.

## Core Concepts

| Concept                 | Meaning                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Candidate               | A PRD draft that passed Reflection as `eligible` or `eligible_with_warnings`.                                                        |
| Grounding               | The hard constraints, conventions, accepted prompt artifacts, product needs, and human-gate decisions that govern the run.           |
| Proximity evidence      | Cluster and similarity information used to choose useful candidate matchups.                                                         |
| Reflection evidence     | Review verdicts, warnings, rationale, and decomposition-readiness notes attached to each candidate.                                  |
| Match                   | A pairwise comparison between two candidates.                                                                                        |
| Rating                  | A relative score updated after each match. New candidates start at `1200` unless a runtime has a calibrated alternative.             |
| Champion recommendation | The highest-ranked eligible candidate plus the rationale and promotion decision.                                                     |
| Workflow state harness  | Target architecture component that owns canonical promotion, blocked, and handoff transitions after tournament evidence is produced. |
| `STATE.md` projection   | Generated human-readable audit ledger of harness state, including tournament receipts and promotion visibility.                      |

Ratings help order candidates, but they do not prove correctness. A candidate
must pass promotion gates before it can become the accepted PRD.

## Phase Position

```text
Prompt Ingestion
  -> PRD Generation
  -> Proximity Filtering
  -> Reflection
  -> PRD Tournament
  -> Champion Recommendation
```

The tournament admits only Reflection-reviewed candidates. It must reject raw
drafts, malformed outputs, Reflection-rejected drafts, blocked drafts, and
evolved child drafts that have not re-entered Reflection.

The tournament is a relative ranking phase. It is not a substitute for
Reflection, Grounding Review, or human approval.

## Workflow State Authority

Tournament records are evidence for the workflow state harness. Ratings,
match outcomes, and champion recommendations do not directly advance the run;
the harness owns canonical transition decisions and checks promotion gates,
required-agent proof, and human-gate status.

`STATE.md` is the generated projection of that canonical state. It remains
durable and reviewable for agents and humans, but it is not the manually edited
source of truth for PRD promotion.

## Purpose

The tournament answers:

```text
Among the PRD candidates that survived Reflection, which candidate is the
strongest basis for downstream technical design?
```

It should identify which candidate best:

- Satisfies the accepted user problem without scope drift.
- Handles hard constraints safely.
- Defines clear and testable acceptance criteria.
- Gives downstream agents a credible validation path.
- Can be decomposed into technical work without guesswork.
- Avoids unnecessary architecture, workflow, data, and migration risk.
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
2. Field, organization, repository, or workflow grounding documents.
3. User-approved hard constraints for the current run.
4. Reflection verdicts and blocking findings.
5. Accepted Step 01 prompt artifacts.
6. Product and technical needs extracted from Step 01.
7. Proximity evidence.
8. Convention parameters.
9. Pairwise judge preference.

A candidate that violates a hard constraint cannot win a match or become
champion. Convention deviations are allowed only when the candidate explains why
the deviation improves the PRD without weakening the run constraints.

## Inputs

Each candidate should carry:

- Candidate id and draft path.
- Parent candidate id, if evolved.
- PM lens or generation origin.
- Proximity cluster.
- Reflection verdict, findings, warnings, and rationale.
- Grounding notes and assumptions.
- Acceptance criteria and validation expectations.

The tournament also receives:

- Proximity clusters, near-duplicate notes, and cross-cluster strategy signals.
- The grounding bundle used by Generation and Reflection.
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
    if candidate is an evolved child draft not yet reviewed:
        return false
    return candidate is eligible or eligible_with_warnings
```

Warnings are allowed only when Reflection marked them as non-blocking. The judge
must still account for them in relevant matches.

## Tournament Flow

```text
Reflection-reviewed PRD candidates
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
candidates, or return to PRD Generation if diversity was expected but failed.

## Match Scheduling

Build the match queue to maximize useful information:

1. Compare candidates within the same Proximity cluster.
2. Compare candidates with similar ratings.
3. Compare the current leader against the strongest distinct challenger.
4. Give newly eligible candidates enough matches to calibrate.
5. Compare high-warning candidates against lower-warning alternatives.
6. Run cross-cluster matches when multiple product strategies survive.
7. Stop matching clearly dominated candidates unless Doric needs an explicit
   loss rationale.

This avoids wasting matches on duplicates while still testing materially
different product strategies.

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

The critic checks hard constraints, warnings, assumptions, and validation gaps.
The judge decides which PRD is stronger for downstream technical design.

## Judge Criteria

The pairwise judge compares candidates against:

| Criterion               | Question                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Product alignment       | Which candidate better satisfies the accepted user problem without scope drift?            |
| Hard constraints        | Does either candidate violate a non-negotiable constraint?                                 |
| Grounding quality       | Which candidate better applies the run's grounding and evidence?                           |
| Acceptance criteria     | Which candidate defines clearer, testable success conditions?                              |
| Validation readiness    | Which candidate gives downstream agents a credible proof path?                             |
| Decomposition readiness | Which candidate can feed technical design without guesswork?                               |
| Risk control            | Which candidate handles operational, security, data, workflow, and migration risks better? |
| Simplicity              | Which candidate solves the problem with less unnecessary scope?                            |
| User decision safety    | Which candidate avoids deciding unresolved user tradeoffs?                                 |
| Reflection evidence     | Which candidate has fewer or less severe remaining warnings?                               |

The judge should not reward more prose, bigger scope, premature implementation
detail, unsupported user stories, aesthetic polish without clearer
requirements, unjustified convention deviations, or ignored Reflection evidence.

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
- Useful losing concepts.
- Notes for Evolution or Meta-review.
- Rating update.

A rating without reasons is not enough to promote a PRD.

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
is safe enough to become the accepted PRD.

## Promotion Gates

A champion PRD can be promoted only when:

- It is Reflection-reviewed.
- It has no blocking findings.
- It does not violate hard constraints.
- Its remaining warnings are acceptable or explicitly deferred.
- The tournament record explains why it beat alternatives.
- Required human gates are satisfied.

For the Doric PRD Evolution Engine, promotion also requires a zero-gap product
gate:

- The latest champion version is the artifact written to `<run>/prd/PRD.md`.
- The champion passes Direct Coverage, Scope Containment, Constraint
  Contradiction, NFR Feasibility, and Implicit Dependency checks.
- `<run>/prd/GAPS.md` is absent, empty of active blocking gaps, or
  explicitly marked superseded by the current champion.
- Accepted child-agent evidence exists for generation, proximity filtering,
  tournament evaluation when applicable, concept grafting, gap analysis,
  mutation when applicable, and championship comparison when applicable.
- Remaining open questions are recorded as non-blocking for technical design.

Promotion means:

```text
Champion reviewed PRD -> accepted PRD -> Technical Design input
```

Promotion does not mean implementation may begin unless the larger workflow
allows skipping technical design and decomposition.

## Outcome Handoffs

Evolution is appropriate when the champion is strongest but repairable, a
losing concept should be grafted into the champion, or the tournament exposes a
recurring weakness in clarity, validation, decomposition readiness, or risk
treatment. The evolved child must re-enter Reflection before it can enter a new
tournament or be promoted.

Meta-review is appropriate when Doric needs a compact pattern summary for
future runs. It should capture common win/loss reasons, repeated grounding
failures, weak acceptance criteria, PM lens gaps, Proximity diversity gaps, and
criteria that were hard for judges to apply. Meta-review should not rewrite the
champion.

## Stop Rules

The tournament stops when one condition is met:

| Stop condition                 | Meaning                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| Champion confidence reached    | The leader has enough wins against relevant challengers.             |
| Match budget exhausted         | The configured compute budget is spent.                              |
| Rating stability reached       | Additional matches are unlikely to change the leader.                |
| Hard-constraint conflict found | A candidate or the whole set is blocked by grounding.                |
| No safe champion               | All candidates have blocking issues or unresolved user dependencies. |
| Human gate required            | The next decision depends on user judgment.                          |

`best_under_budget` is a reportable tournament outcome, not an accepted PRD. It
can feed a user decision, another generation round, or a narrower prompt, but it
must not advance to technical design unless promotion gates pass.

## Artifact Contract

A generic implementation should persist:

| Artifact                               | Purpose                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `<run>/prd/logs/tournament_evals.json` | Candidate registry, pairwise outcomes, ratings, and final ranking.                                     |
| `<run>/prd/logs/evolution.md`          | Human-readable tournament summary, champion rationale, and residual risk.                              |
| `<run>/prd/PRD.md`                     | Accepted zero-gap champion after promotion.                                                            |
| `<run>/prd/GAPS.md`                    | Active product gap when the champion is not yet promotable.                                            |
| `<run>/STATE.md` Agent receipts        | Harness-generated audit projection of spawn proof and acceptance status for tournament evaluator work. |

The harness may maintain machine-readable canonical state, but the
human-readable projection is required because PRD selection affects the rest of
the workflow.

## Failure Modes

| Failure mode                           | Mitigation                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Raw drafts enter the tournament.       | Admit only Reflection-reviewed candidates.                              |
| Rating hides hard-constraint failures. | Treat hard constraints as eligibility gates and match losses.           |
| Judge rewards verbosity or scope.      | Use stable criteria and concise match rationales.                       |
| Proximity is ignored.                  | Build match queues from Proximity clusters.                             |
| Reflection evidence is ignored.        | Attach Reflection findings to every match prompt.                       |
| Champion has unresolved warnings.      | Promote only clean champions or send repairable champions to Evolution. |
| Too many matches run.                  | Use budgets, single-turn matches, and confidence stop rules.            |
| Too few matches run.                   | Require relevant wins against similar and distinct challengers.         |

## Minimal Implementation

A minimal PRD tournament needs:

1. Candidate eligibility check based on Reflection.
2. Initial rating for eligible candidates.
3. Match queue built from Proximity and Reflection evidence.
4. Pairwise judge prompt for single-turn comparisons.
5. Optional multi-turn debate for top or close candidates.
6. Rating update logic.
7. Match records with rationale.
8. Champion recommendation.
9. Promotion, Evolution, or blocked outcome.

It does not need new PRD generation, Reflection execution, code mutation,
technical design generation, or automatic Evolution inside a match.

## Summary

The PRD tournament is Doric's ranking phase for Reflection-reviewed PRD
candidates. It uses ratings to track pairwise outcomes, Proximity to choose
useful matches, Reflection evidence to keep comparisons grounded, and hard
constraints as gates.

The output is a champion PRD recommendation with an auditable tournament record.
A clean champion can be submitted to the harness for advancement to technical
design. A repairable champion should go to Evolution, which creates a child PRD
that must pass Reflection again before it can be ranked or promoted.
