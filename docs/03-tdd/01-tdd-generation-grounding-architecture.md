# TDD Generation Grounding Architecture

This document defines Doric Step 03 TDD Generation. It is internal,
self-contained guidance for creating grounded Technical Design Document
candidates from the accepted PRD, architecture-scoped prompt artifacts, current
repository evidence, and applicable engineering standards.

Step 03 does not choose the final technical design. It creates a diverse,
auditable set of raw TDD drafts that can move through Proximity Filtering,
Reflection, Ranking, and Evolution before any TDD is accepted for
decomposition.

## Purpose

Step 03 answers one question:

```text
What are the strongest materially different technical designs that could
satisfy the accepted PRD, prompt architecture constraints, and current
repository architecture?
```

Step 03 must not decide:

- Which TDD is final.
- Which implementation effort should begin first.
- How code should change.
- Which product requirement from the PRD may be ignored.
- Which unresolved architecture question should be silently answered for the
  user.

The phase output is candidate material only. A raw draft cannot bypass
Proximity, Reflection, Ranking, or the zero-gap promotion gate.

## Non-Negotiable Rules

- Do not begin if Step 02 has not produced an accepted zero-gap
  `<run>/prd/PRD.md`.
- Save every TDD-owned process artifact under `<run>/tdd/`. This includes TDD
  candidates, detailed agent files, logs, tournament records, gap artifacts, and
  the promoted `<run>/tdd/TDD.md`. The shared human-readable run projection and
  audit ledger remains `<run>/STATE.md`; TDD process files must not be written
  to the run root.
- Route TDD phase eligibility, receipt status, and handoff transitions through
  the target workflow state harness. `STATE.md` is generated from that
  canonical state for visibility and review.
- Treat `<run>/prd/PRD.md` as the product source of truth.
- Use architecture-scoped sections of `PROMPT.md` only for hard prompt
  constraints, accepted architecture requirements, and architecture-tagged open
  questions that the PRD intentionally preserved.
- Verify current repository architecture before making package, boundary,
  dependency, API, persistence, test, or runtime claims.
- Separate hard constraints from convention parameters.
- Do not let an architect lens override hard constraints, accepted user
  decisions, product scope, or repository grounding.
- Keep TDD Generation read-only. Architect agents may inspect context, but they
  cannot edit code, prompt artifacts, PRD artifacts, or grounding documents.
- Do not use Generation or Evolution to invent missing product or architecture
  decisions.
- Do not promote "best draft so far" to decomposition. Promotion requires a
  zero-gap accepted TDD and the explicit `tdd_to_decomposition` human gate.

## Workflow State Authority

In the target architecture, the workflow state harness owns canonical TDD phase
transitions in code. The Generation Supervisor can assemble evidence,
recommend readiness, and record spawned-agent outcomes, but the harness is the
transition authority for whether TDD generation may begin and whether later TDD
evidence can advance the workflow.

`STATE.md` remains required because humans and agents need a durable
human-readable view of the run. It is a generated projection and audit ledger
of harness state, not the manually edited source of truth for transitions.

## Grounding Model

Grounding is the set of constraints and conventions every draft must obey.

Hard constraints are non-negotiable requirements from safety, user approval,
workflow gates, repository rules, permissions, data handling, current
architecture, or current run decisions.

Convention parameters are preferred package patterns, implementation style,
validation style, documentation expectations, testing norms, and team
practices.

When inputs conflict, apply this authority order:

1. System and runtime safety requirements.
2. Doric workflow gates and repository-level grounding.
3. User-approved hard constraints for the current run.
4. Accepted `<run>/prd/PRD.md` product requirements.
5. Architecture-scoped hard constraints from `PROMPT.md`.
6. Current repository code, manifests, schemas, tests, generated contracts, and
   architecture documents.
7. Technical needs extracted from the PRD and prompt.
8. Convention parameters and reusable method guidance.
9. Architect lens emphasis.

The architect lens is intentionally last. It can focus attention, but it cannot
change accepted scope or invent current implementation facts.

## Inputs

| Input                         | Path                                    | Purpose                                                                                                                                                       |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted PRD                  | `<run>/prd/PRD.md`                      | Defines the product source of truth, goals, non-goals, user-visible behavior, requirements, acceptance criteria, and validation expectations.                 |
| Prompt architecture state     | `<run>/PROMPT.md`                       | Preserves architecture-scoped prompt constraints, architecture-tagged questions, accepted technical context, and prompt facts that the PRD did not supersede. |
| Technical grounding bundle    | Run-specific grounding artifacts        | Provides hard technical constraints, convention parameters, package ownership, dependency direction, validation expectations, and human-gate decisions.       |
| Current architecture evidence | Source, manifests, schemas, tests, docs | Anchors package boundaries, existing APIs, data models, runtime behavior, test tooling, and migration constraints in the real repository.                     |
| Prior technical gaps          | `<run>/tdd/GAPS.md` when repairing      | Supplies the active blocking technical gap that a Challenger must resolve.                                                                                    |

Step 03 must refuse to run if `<run>/prd/PRD.md` is missing, still has active
product gaps, or lacks the approval evidence required by the PRD phase.

Before spawning architect agents, the Supervisor converts these inputs into one
shared generation brief. The brief should include objective, product scope,
non-goals, acceptance themes, hard constraints, convention parameters, affected
repository areas, known architecture risks, validation expectations,
non-blocking open questions, candidate budget, and required architect lenses.

## Architect Lenses

Parallel architect agents use bounded lenses to create meaningful design
diversity. A lens is a narrow instruction set, not uncontrolled role-play. It
defines what the agent emphasizes, which risks it should catch, and which
assumptions it must avoid.

Default lenses:

| Architect lens                       | Focus                                                                                                  | Failure avoided                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| System Boundary Architect            | Package ownership, dependency direction, API surfaces, event flow, and integration seams               | A plausible design that violates repository architecture              |
| Implementation Feasibility Architect | Concrete code paths, data flow, test seams, rollout size, and compatibility with existing tooling      | A desirable design that cannot be implemented or proven incrementally |
| Risk And Operations Architect        | Security, persistence, migration, observability, failure recovery, command execution, and blast radius | A fluent design that hides operational or safety risk                 |

Optional lenses may be added only when the accepted PRD, prompt, or repository
evidence requires them:

| Optional lens                 | Use when                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Data Or Persistence Architect | Stored state, schema, migration, replay, cache, retention, or durability concerns matter.                     |
| Security Architect            | Auth, permissions, secrets, untrusted input, code execution, network access, or sensitive data are involved.  |
| UX Or Workflow Architect      | CLI, TUI, web, onboarding, recovery, progress, error, or daily operator flows change.                         |
| Performance Architect         | Throughput, latency, memory, concurrency, streaming, cancellation, or scale constraints matter.               |
| Testing Architect             | The feature depends on complex fixtures, mocks, regression suites, generated contracts, or test architecture. |

The Supervisor chooses lenses before spawning architect agents. Architect agents
do not select their own lenses after work begins.

Default budget:

```text
minimum raw drafts: 3
default architect agents: 3
maximum first-pass architect agents: 5 unless explicitly configured
```

Increase the budget only when multiple viable technical paths exist, the cost
of a wrong architecture is high, constraints compete, migration or compatibility
risk is high, or the feature crosses multiple package boundaries. Decrease it
when the accepted PRD and current architecture imply one obvious low-risk
implementation path.

## Draft Diversity

Good diversity means different ways to satisfy the same accepted PRD and hard
constraints:

- Different package or ownership boundaries that still obey dependency
  direction.
- Different data or state models.
- Different API, command, event, or interface shapes.
- Different rollout, migration, or compatibility strategies.
- Different test and validation strategies.
- Different risk containment strategies.

Bad diversity is not useful:

- The same design with different wording.
- Arbitrary architecture expansion.
- Unverified claims about current code.
- Design that changes product scope.
- Design that skips Dependency Hops.

During initial generation, architect agents should run independently. They
receive the same generation brief, use distinct lenses, avoid reading each
other's drafts, and write separate draft files.

## Outputs

### Raw TDD Drafts

Storage:

```text
<run>/tdd/logs/evolution.md candidate entries
<run>/tdd/agents/*.md optional detailed candidate records
```

Each draft is a raw candidate. It is not tournament eligible until it passes
Proximity and Reflection.

Each draft should include:

- Candidate title.
- Architect lens used.
- Inputs and repository evidence read.
- PRD requirement mapping.
- Current architecture context.
- Proposed design.
- Data model changes, if any.
- API, command, event, tool, or interface contracts, if any.
- Dependency Hops.
- Security and privacy considerations.
- Performance and operational considerations.
- Testing strategy and validation proof.
- Rollout, migration, and compatibility plan.
- Technical alternatives considered.
- Assumptions, risks, and tradeoffs.
- Grounding notes.
- Non-blocking open questions.
- Decomposition considerations.

Decomposition considerations should capture sequencing and effort boundaries,
not a full implementation plan.

### Generation Manifest

Storage:

```text
<run>/STATE.md Agent receipts
<run>/tdd/logs/evolution.md generation summary
```

The manifest lists spawned architect agents, each architect lens, generated
draft paths, inputs each architect received, generation failures or skipped
agents, and whether the minimum candidate budget was met.

In the target architecture, receipt status is canonical in the workflow state
harness and is projected into `STATE.md` for audit.

### Proximity Input Set

Storage:

```text
<run>/tdd/logs/evolution.md unique-candidate list
```

This file lists raw drafts eligible for Proximity Filtering and excludes
malformed drafts that failed the basic artifact contract. It is not a review
result.

## Tool Policy

Architect agents may use read-only exploration tools when the generation brief
or lens requires evidence from the workspace, documentation, code, manifests,
tests, generated contracts, or existing Doric artifacts.

Recommended capabilities:

| Capability        | Use                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read()`          | Read specific prompt artifacts, PRDs, grounding documents, architecture summaries, manifests, schemas, tests, code files, or prior gap reports.    |
| `tree()`          | Inspect workspace, package, code, or documentation structure so a draft respects actual boundaries.                                                |
| Search-like tools | Find terminology, existing APIs, data models, state transitions, validation patterns, event contracts, or user-facing strings that affect the TDD. |

Architect agents can use tools to understand context, but they cannot mutate
context. They should call tools only when the brief or lens requires evidence,
record which evidence changed the draft, and prefer targeted reads over broad
exploration.

Forbidden in Step 03 Generation:

- Editing code.
- Editing accepted prompt or PRD artifacts.
- Mutating grounding documents.
- Running implementation commands as proof of the TDD.
- Creating the final accepted TDD.
- Running Evolution.
- Running Ranking.
- Starting decomposition or implementation.

## Flow

```text
Accepted Step 01 and Step 02 artifacts
  |
  +-- <run>/PROMPT.md architecture-scoped constraints
  `-- <run>/prd/PRD.md accepted product source of truth
  |
  v
Supervisor asks workflow state harness to verify Step 03 may start
  |
  v
Grounding Loader loads hard constraints, convention parameters, and repo evidence needs
  |
  v
Supervisor builds one shared technical generation brief
  |
  v
Supervisor selects architect lenses and candidate budget
  |
  v
Parallel architect agents run independently
  |
  +-- each architect receives the same brief
  +-- each architect receives one bounded lens
  +-- each architect may use read-only exploration tools when evidence is needed
  `-- each architect writes raw TDD draft(s)
  |
  v
Supervisor records drafts in <run>/tdd/logs/evolution.md
  |
  v
Supervisor records Agent receipts through the harness and writes generation summary
  |
  v
Malformed outputs are excluded from Proximity input
  |
  v
Raw draft set enters Proximity Filtering
  |
  v
Selected distinct drafts enter Reflection
```

## Basic Artifact Contract

Before drafts enter Proximity, the Supervisor performs a cheap artifact check.
This is not Reflection. It only verifies that the draft can safely participate
in later review.

The check asks:

- Was the draft saved in the expected path?
- Does it identify its architect lens?
- Does it name the inputs and repository evidence it used?
- Does it map major PRD requirements to technical paths?
- Does it include current architecture context?
- Does it include Dependency Hops?
- Does it include a testing strategy?
- Does it list assumptions and risks?
- Does it avoid code edits and implementation patches?
- Does it avoid claiming to be the final accepted TDD?

If a draft fails this contract, the Supervisor may exclude it or spawn a
replacement architect agent under the same lens. Exclusion is not an
architecture judgment.

## Handoffs

### Proximity

Proximity runs after raw generation and before Reflection. It clusters
near-duplicate designs, preserves materially distinct candidates, selects
representatives from meaningful clusters, identifies complementary designs for
possible later Evolution, and flags draft families that overfit the same
architecture assumption.

Proximity does not approve, reject, repair, rank, or replace a TDD. Selected
drafts remain raw until Reflection.

### Reflection

Reflection receives selected raw drafts from Proximity. The handoff should
include draft path, architect lens, inputs used, similarity cluster notes,
sibling drafts, declared assumptions and risks, Dependency Hops, and malformed
drafts excluded before Proximity.

Reflection evaluates the design itself, not the reputation of the architect
lens.

### Ranking

Ranking does not run during raw generation.

Valid order:

```text
TDD Generation
  -> Proximity Filtering
  -> Reflection
  -> Elo Ranking
```

Ranking compares reviewed candidates with review evidence attached. Running it
directly over raw drafts would reward fluency before Doric knows whether the
design obeys constraints and current architecture.

### Evolution

Evolution is not part of initial raw generation.

Generation creates sibling candidates from the same accepted input bundle:

```text
input bundle -> Architect 1 draft
input bundle -> Architect 2 draft
input bundle -> Architect 3 draft
```

Evolution creates child candidates from an existing candidate plus review,
ranking, proximity, or Dependency Hop evidence:

```text
reviewed draft + findings -> evolved child draft
```

Use Evolution only after there is evidence about how an existing candidate
should be repaired or improved. An evolved child draft must re-enter Reflection
before it can be ranked or promoted.

## Promotion Gate

A generated draft becomes an accepted TDD only after the later TDD Evolution
Engine selects a champion and that champion has no blocking technical gaps.

If the champion still has a blocking technical gap, Doric should write the
blocker to `<run>/tdd/GAPS.md`, ask the user when the blocker depends on judgment,
or spawn a fresh mutation and evaluation cycle when the blocker can be repaired
from existing accepted inputs.

`<run>/tdd/GAPS.md` mirrors the Step 02 `<run>/prd/GAPS.md` role. It is the
phase-local active technical gap artifact for a non-promotable champion, not a
general scratchpad for every reviewer note.

Doric must never treat "best draft so far" as "good enough" for decomposition.
After a clean champion is written to `<run>/tdd/TDD.md`, the coordinator must still
request explicit user approval and record `tdd_to_decomposition` before
starting decomposition.

## Missing Information

TDD Generation must not invent missing product or architecture decisions. If
Step 02 did not resolve a product-scope question, Step 03 blocks and returns to
the PRD or prompt alignment gate. If the design depends on an irreversible
architecture choice that the user must make, Step 03 blocks for user input.

Allowed:

- Labeling a non-blocking assumption.
- Creating alternative drafts around explicitly allowed technical
  interpretations.
- Asking the Supervisor to return to PRD repair or user alignment.
- Marking a draft incomplete because the input bundle is insufficient.

Not allowed:

- Treating an assumption as a requirement.
- Using Evolution to repair missing user answers.
- Asking architect agents to decide product scope that the user has not
  accepted.
- Claiming repository behavior without evidence from current files.

Technical personas may pressure-test assumptions, questions, and risks. They
must not become evidence for current implementation facts unless repository
evidence already exists.

## Failure Modes

| Failure mode                                         | Mitigation                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Architect agents converge on the same design         | Use distinct lenses and prevent architects from reading each other's drafts during initial generation.      |
| Architect agents invent current code facts           | Require repository evidence for package, API, schema, runtime, and test claims.                             |
| Product scope changes inside the TDD                 | Treat `<run>/prd/PRD.md` as authoritative and route product changes back to PRD repair or user input.       |
| Design skips Dependency Hops                         | Exclude malformed drafts before Proximity or spawn a replacement architect.                                 |
| Proximity filters too aggressively                   | Preserve at least one representative per materially distinct architecture, state, API, or rollout strategy. |
| Raw draft is treated as final                        | Mark all architect outputs as raw candidates and block direct promotion.                                    |
| Missing architecture input is repaired by Generation | Ask the user or return to the correct gate for scope-defining or irreversible decisions.                    |
| Too many architect lenses are spawned                | Use the default three lenses and add more only from evidence.                                               |

## Minimal Implementation

A minimal implementation of Step 03 Generation needs:

1. PRD artifact readiness check.
2. Grounding and repository evidence loader.
3. Shared technical generation brief builder.
4. Architect lens selection policy.
5. Parallel architect agent runner.
6. Read-only tool policy for architect agents.
7. Draft recorder under `<run>/tdd/logs/evolution.md`.
8. Basic artifact contract check.
9. Generation manifest.
10. Proximity input set.
11. Harness-backed phase readiness and `STATE.md` projection updates.

It does not need Elo tournament logic, Reflection orchestration, Evolution
repair, code mutation, decomposition generation, or a generated authoritative
grounding file.

## Summary

Step 03 TDD Generation creates multiple grounded technical design candidates
from the accepted PRD, architecture-scoped prompt state, current repository
evidence, and applicable standards. It uses hard constraints, convention
parameters, a shared brief, and bounded architect lenses to produce diverse raw
drafts without losing traceability.

The correct output is not a final TDD. It is a set of durable candidate drafts
ready for Proximity Filtering and Reflection. Only later review, ranking,
evolution, zero-gap promotion, and explicit `tdd_to_decomposition` approval can
make one draft the accepted technical design for decomposition.
