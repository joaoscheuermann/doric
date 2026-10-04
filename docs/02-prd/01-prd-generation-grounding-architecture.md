# PRD Generation Grounding Architecture

This document defines Doric Step 02 PRD Generation. It is internal,
self-contained guidance for creating grounded PRD candidates from the accepted
Step 01 artifacts.

Step 02 does not choose the final PRD. It creates a diverse, auditable set of
raw PRD drafts that can move through Proximity Filtering, Reflection, Ranking,
and Evolution before any PRD is accepted for technical design.

## Purpose

Step 02 answers one question:

```text
What are the strongest materially different PRD drafts that could satisfy the
accepted prompt state and grounding constraints?
```

Step 02 must not decide:

- Which PRD is final.
- Which implementation architecture should be used.
- How code should change.
- Which unresolved product question should be silently answered for the user.

The phase output is candidate material only. A raw draft cannot bypass
Proximity, Reflection, Ranking, or the zero-gap promotion gate.

## Non-Negotiable Rules

- Do not begin if Step 01 is blocked or any scope-defining question remains
  open.
- Save every PRD-owned process artifact under `<run>/prd/`. This includes PRD
  candidates, detailed agent files, logs, tournament records, gap artifacts, and
  the promoted `<run>/prd/PRD.md`. The shared human-readable run projection and
  audit ledger remains `<run>/STATE.md`; PRD process files must not be written
  to the run root.
- Route PRD phase eligibility, receipt status, and handoff transitions through
  the target workflow state harness. `STATE.md` is generated from that
  canonical state for visibility and review.
- Treat accepted Step 01 artifacts as the task configuration, not loose
  background context.
- Separate hard constraints from convention parameters.
- Do not let a PM lens override hard constraints, accepted user decisions, or
  product scope.
- Keep PRD Generation read-only. PM agents may inspect context, but they cannot
  edit code, prompt artifacts, or grounding documents.
- Do not use Generation or Evolution to invent missing user intent.
- Do not promote "best draft so far" to technical design. Promotion requires a
  zero-gap accepted PRD from the later PRD Evolution Engine.

## Workflow State Authority

In the target architecture, the workflow state harness owns canonical PRD phase
transitions in code. The Generation Supervisor can assemble evidence,
recommend readiness, and record spawned-agent outcomes, but the harness is the
transition authority for whether PRD generation may begin and whether later PRD
evidence can advance the workflow.

`STATE.md` remains required because humans and agents need a durable
human-readable view of the run. It is a generated projection and audit ledger
of harness state, not the manually edited source of truth for transitions.

## Grounding Model

Grounding is the set of constraints and conventions every draft must obey.

Hard constraints are non-negotiable requirements from safety, user approval,
workflow gates, repository rules, permissions, data handling, or current run
decisions.

Convention parameters are preferred patterns, terminology, validation style,
documentation expectations, product norms, and team practices.

When inputs conflict, apply this authority order:

1. System and runtime safety requirements.
2. Doric workflow gates and repository-level grounding.
3. User-approved hard constraints for the current run.
4. Accepted Step 01 prompt state.
5. Product needs extracted from Step 01.
6. Technical constraints extracted from Step 01.
7. Convention parameters and reusable method guidance.
8. PM lens emphasis.

The PM lens is intentionally last. It can focus attention, but it cannot change
accepted scope.

## Inputs

| Input                     | Path                             | Purpose                                                                                                                                                         |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt state              | `<run>/PROMPT.md`                | Preserves accepted prompt history, clarification decisions, open-question status, Prompt Reflection status, known constraints, and unresolved conflicts.        |
| Product requirements      | `<run>/PROMPT.md`                | Defines the user-visible problem, goals, non-goals, users, workflows, outcomes, and acceptance expectations. This is the main PRD input.                        |
| Architecture requirements | `<run>/PROMPT.md`                | Captures platform constraints, integration boundaries, architecture-relevant facts, validation needs, and feasibility limits without becoming technical design. |
| Grounding bundle          | Run-specific grounding artifacts | Provides hard constraints, convention parameters, current architecture or product evidence, user approvals, and human-gate decisions.                           |

Step 02 must refuse to run if `PROMPT.md` says Prompt Reflection is blocked or
scope-defining questions remain open.

Before spawning PM agents, the Supervisor converts these inputs into one shared
generation brief. The brief should include objective, scope, non-goals, users,
acceptance themes, hard constraints, convention parameters, known risks,
validation expectations, non-blocking open questions, candidate budget, and
required PM lenses.

## PM Lenses

Parallel PM agents use bounded lenses to create meaningful draft diversity. A
lens is a narrow instruction set, not uncontrolled role-play. It defines what
the agent emphasizes, which risks it should catch, and which assumptions it must
avoid.

Default lenses:

| PM lens               | Focus                                                                    | Failure avoided                                        |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| User Value PM         | User workflows, outcomes, acceptance criteria, non-goals                 | A plausible PRD that does not solve the user's problem |
| Feasibility PM        | Technical constraints, system boundaries, validation realism             | A desirable PRD that cannot be implemented or proven   |
| Risk And Grounding PM | Hard constraints, permissions, security, ambiguity, irreversible actions | A fluent PRD that violates constraints or hides risk   |

Optional lenses may be added only when the accepted prompt or grounding requires
them:

| Optional lens          | Use when                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Business Or Company PM | Rollout, cost, support, adoption, compliance, or operating constraints matter.                               |
| Security PM            | Auth, permissions, secrets, untrusted input, code execution, network access, or sensitive data are involved. |
| Code Quality PM        | Maintainability, package boundaries, migration burden, testing strategy, or repeated workflows are central.  |
| UX Or Workflow PM      | Human-facing CLI, TUI, web, onboarding, error, recovery, or daily operator flows change.                     |
| Domain Expert PM       | The product area depends on specialized domain knowledge.                                                    |

The Supervisor chooses lenses before spawning PM agents. PM agents do not select
their own lenses after work begins.

Default budget:

```text
minimum raw drafts: 3
default PM agents: 3
maximum first-pass PM agents: 5 unless explicitly configured
```

Increase the budget only when the request has multiple plausible product
framings, the cost of a wrong PRD is high, constraints compete, different user
groups must be explored, or technical or operational risk is unusually high.
Decrease it when the request is tiny, tightly specified, constrained to one
viable shape, explicitly narrowed by the user, or operating under strict
latency or cost limits.

## Draft Diversity

Good diversity means different ways to satisfy the same accepted scope and hard
constraints:

- Different scope boundaries.
- Different product tradeoffs.
- Different risk treatments.
- Different acceptance criteria emphasis.
- Different decomposition readiness.

Bad diversity is not useful:

- The same draft with different wording.
- Arbitrary feature expansion.
- Persona-specific prose style.
- Unsupported user stories.

During initial generation, PM agents should run independently. They receive the
same generation brief, use distinct lenses, avoid reading each other's drafts,
and write separate draft files.

## Outputs

### Raw PRD Drafts

Storage:

```text
<run>/prd/logs/evolution.md candidate entries
<run>/prd/agents/*.md optional detailed candidate records
```

Each draft is a raw candidate. It is not tournament eligible until it passes
Proximity and Reflection.

Each draft should include:

- Candidate title.
- PM lens used.
- Inputs read.
- Problem statement.
- Target user or operator.
- Goals and non-goals.
- User-visible behavior.
- Product requirements.
- Acceptance criteria.
- Validation expectations.
- Assumptions.
- Risks and tradeoffs.
- Grounding notes.
- Non-blocking open questions.
- Technical-design considerations.

Technical-design considerations should capture constraints and downstream
concerns, not a full implementation plan.

### Generation Manifest

Storage:

```text
<run>/STATE.md Agent receipts
<run>/prd/logs/evolution.md generation summary
```

The manifest lists spawned PM agents, each PM lens, generated draft paths,
inputs each PM received, generation failures or skipped agents, and whether the
minimum candidate budget was met.

In the target architecture, receipt status is canonical in the workflow state
harness and is projected into `STATE.md` for audit.

### Proximity Input Set

Storage:

```text
<run>/prd/logs/evolution.md unique-candidate list
```

This file lists raw drafts eligible for Proximity Filtering and excludes
malformed drafts that failed the basic artifact contract. It is not a review
result.

## Tool Policy

PM agents may use read-only exploration tools when the generation brief or lens
requires evidence from the workspace, documentation, product behavior, or
accepted run artifacts.

Recommended capabilities:

| Capability        | Use                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read()`          | Read specific prompt artifacts, grounding documents, product notes, technical notes, architecture summaries, requirements, examples, tests, or code files. |
| `tree()`          | Inspect workspace, package, code, or documentation structure so a draft respects actual boundaries.                                                        |
| Search-like tools | Find terminology, constraints, workflows, APIs, data models, existing behavior, validation patterns, or user-facing strings that affect the PRD.           |

PM agents can use tools to understand context, but they cannot mutate context.
They should call tools only when the brief or lens requires evidence, record
which evidence changed the draft, and prefer targeted reads over broad
exploration.

Forbidden in Step 02 Generation:

- Editing code.
- Editing accepted prompt artifacts.
- Mutating grounding documents.
- Running implementation commands as proof of a PRD.
- Creating the final accepted PRD.
- Running Evolution.
- Running Ranking.

## Flow

```text
Accepted Step 01 artifacts
  |
  `-- <run>/PROMPT.md
      +-- product requirements
      `-- architecture requirements
  |
  v
Supervisor asks workflow state harness to verify Step 01 allows PRD generation
  |
  v
Grounding Loader loads hard constraints and convention parameters
  |
  v
Supervisor builds one shared generation brief
  |
  v
Supervisor selects PM lenses and candidate budget
  |
  v
Parallel PM agents run independently
  |
  +-- each PM receives the same brief
  +-- each PM receives one bounded lens
  +-- each PM may use read-only exploration tools when evidence is needed
  `-- each PM writes raw PRD draft(s)
  |
  v
Supervisor records drafts in <run>/prd/logs/evolution.md
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
- Does it identify its PM lens?
- Does it name the inputs it used?
- Does it include goals and non-goals?
- Does it include acceptance criteria?
- Does it list assumptions and risks?
- Does it avoid code edits and implementation patches?
- Does it avoid claiming to be the final accepted PRD?

If a draft fails this contract, the Supervisor may exclude it or spawn a
replacement PM agent under the same lens. Exclusion is not a product judgment.

## Handoffs

### Proximity

Proximity runs after raw generation and before Reflection. It clusters
near-duplicate drafts, preserves materially distinct candidates, selects
representatives from meaningful clusters, identifies complementary drafts for
possible later Evolution, and flags draft families that overfit the same
assumption.

Proximity does not approve, reject, repair, rank, or replace a PRD. Selected
drafts remain raw until Reflection.

### Reflection

Reflection receives selected raw drafts from Proximity. The handoff should
include draft path, PM lens, inputs used, similarity cluster notes, sibling
drafts, declared assumptions and risks, and malformed drafts excluded before
Proximity.

Reflection evaluates the draft itself, not the reputation of the PM lens.

### Ranking

Ranking does not run during raw generation.

Valid order:

```text
PRD Generation
  -> Proximity Filtering
  -> Reflection
  -> Elo Ranking
```

Ranking compares reviewed candidates with review evidence attached. Running it
directly over raw drafts would reward fluency before Doric knows whether the
drafts obey constraints.

### Evolution

Evolution is not part of initial raw generation.

Generation creates sibling candidates from the same accepted input bundle:

```text
input bundle -> PM 1 draft
input bundle -> PM 2 draft
input bundle -> PM 3 draft
```

Evolution creates child candidates from an existing candidate plus review,
ranking, or proximity evidence:

```text
reviewed draft + findings -> evolved child draft
```

Use Evolution only after there is evidence about how an existing candidate
should be repaired or improved. An evolved child draft must re-enter Reflection
before it can be ranked or promoted.

## Promotion Gate

A generated draft becomes an accepted PRD only after the later PRD Evolution
Engine selects a champion and that champion has no blocking product gaps.

If the champion still has a blocking product gap, Doric should write the blocker
to `<run>/prd/GAPS.md`, ask the user when the blocker depends on judgment, or
spawn a fresh mutation and evaluation cycle when the blocker can be repaired
from existing accepted inputs.

Doric must never treat "best draft so far" as "good enough" for technical
design.

## Missing Information

PRD Generation must not invent missing user intent. If Step 01 did not resolve a
scope-defining question, Step 02 blocks and returns to user alignment.

Allowed:

- Labeling a non-blocking assumption.
- Creating alternative drafts around explicitly allowed interpretations.
- Asking the Supervisor to return to Prompt Ingestion.
- Marking a draft incomplete because the prompt bundle is insufficient.

Not allowed:

- Treating an assumption as a requirement.
- Using Evolution to repair missing user answers.
- Asking PM agents to decide product scope that the user has not accepted.
- Letting synthetic user archetypes create authoritative requirements.

Synthetic user archetypes may pressure-test assumptions, questions, and risks.
They must not become evidence for user facts unless accepted user evidence
already exists.

## Failure Modes

| Failure mode                                  | Mitigation                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| PM agents converge on the same draft          | Use distinct lenses and prevent PMs from reading each other's drafts during initial generation. |
| PM agents invent user facts                   | Treat archetype output as assumptions unless backed by accepted evidence.                       |
| Technical PM writes a technical design        | Restrict technical content to constraints, risks, and validation expectations.                  |
| Product PM ignores hard constraints           | Include hard constraints in the shared brief and run artifact checks before Proximity.          |
| Proximity filters too aggressively            | Preserve at least one representative per materially distinct scope, user, or risk strategy.     |
| Raw draft is treated as final                 | Mark all PM outputs as raw candidates and block direct promotion.                               |
| Missing user intent is repaired by Generation | Return to Step 01 or human alignment for scope-defining gaps.                                   |
| Too many PM lenses are spawned                | Use the default three lenses and add more only from evidence.                                   |

## Minimal Implementation

A minimal implementation of Step 02 Generation needs:

1. Prompt artifact readiness check.
2. Grounding loader.
3. Shared generation brief builder.
4. PM lens selection policy.
5. Parallel PM agent runner.
6. Read-only tool policy for PM agents.
7. Draft recorder under `<run>/prd/logs/evolution.md`.
8. Basic artifact contract check.
9. Generation manifest.
10. Proximity input set.
11. Harness-backed phase readiness and `STATE.md` projection updates.

It does not need Elo tournament logic, Reflection orchestration, Evolution
repair, technical design generation, code mutation, or a generated authoritative
grounding file.

## Summary

Step 02 PRD Generation creates multiple grounded PRD candidates from accepted
Step 01 artifacts. It uses hard constraints, convention parameters, a shared
brief, and bounded PM lenses to produce diverse raw drafts without losing
traceability.

The correct output is not a final PRD. It is a set of durable candidate drafts
ready for Proximity Filtering and Reflection. Only later review, ranking,
evolution, and zero-gap promotion can make one draft the accepted PRD for
technical design.
