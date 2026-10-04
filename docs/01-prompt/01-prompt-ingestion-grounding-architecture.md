# Prompt Ingestion Grounding Architecture

This document defines Doric Step 01: prompt ingestion and grounding. The phase
turns an initial user request into a durable, auditable input bundle for PRD
generation.

Step 01 does not write the PRD, design the implementation, or resolve missing
user intent by guessing. It normalizes the request, asks targeted clarification
questions, records grounding constraints, and produces the artifacts that later
agents can safely use.

## Goal

Prompt ingestion is complete when Doric has:

- A canonical prompt state in `<run>/PROMPT.md`.
- Product requirements and architecture requirements separated inside
  `<run>/PROMPT.md`.
- Explicit hard constraints, convention parameters, open questions, and
  revision history.
- A Prompt Reflection result showing that downstream PRD generation can begin,
  begin with warnings, or must wait for more input.

## Core Concepts

| Concept                   | Contract                                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial prompt            | The user's starting request. It is task context, not a complete plan.                                                                                                                                     |
| Prompt state              | The current normalized understanding of the request. Stored durably in `PROMPT.md`.                                                                                                                       |
| Prompt Supervisor         | The phase-local coordinator for Step 01. It owns the prompt loop, artifacts, and human-gate interactions, and submits workflow transition requests to the state harness.                                  |
| Workflow state harness    | Target architecture component that owns canonical workflow state transitions, including legal phase moves, approval state, required-agent gates, and stop states.                                         |
| `STATE.md` projection     | A durable, human-readable generated projection and audit ledger of harness state. Agents and humans read it for visibility and review; they do not treat manual edits as the canonical transition source. |
| Grounding context         | The rules and constraints that govern the run. It includes safety, repository, workflow, and user-approved run constraints.                                                                               |
| Hard constraint           | A non-negotiable invariant. If it conflicts with the prompt, the run blocks or asks for a decision.                                                                                                       |
| Convention parameter      | A default preference or project convention. It guides work but can be overridden with justification.                                                                                                      |
| Clarification lens        | A focused angle for questioning, such as scope, validation, technical context, or risk.                                                                                                                   |
| Fresh question agent      | A short-lived worker for one lens or round. It reads current state and proposes questions.                                                                                                                |
| Human Gate Channel        | The interaction point where Doric asks the user for decisions or missing information.                                                                                                                     |
| Answer Integrator         | The component that turns explicit user answers into prompt-state revisions.                                                                                                                               |
| Prompt Reflection         | The quality gate that checks completeness, consistency, grounding, and readiness for extraction.                                                                                                          |
| Product Needs Extractor   | Writes the product-scoped section of `PROMPT.md` without choosing implementation details.                                                                                                                 |
| Technical Needs Extractor | Writes the architecture-scoped section of `PROMPT.md` without becoming a technical design.                                                                                                                |

## Authority And Grounding

Doric should not treat the first user prompt as the highest authority. The first
prompt can introduce goals, preferences, and constraints, but it can also be
incomplete or conflict with stronger rules.

Recommended authority order:

1. System and runtime safety rules.
2. Repository, organization, or domain grounding documents.
3. User-approved hard constraints for the current run.
4. Project and workflow rules.
5. Reusable skills or method guidance.
6. The current task prompt and follow-up answers.

Grounding behavior:

- Load grounding before generating clarification questions.
- Separate hard constraints from convention parameters and preferences.
- Block or ask the user when prompt intent conflicts with a hard constraint.
- Carry convention parameters forward as defaults, not absolute requirements.
- Mark inferred or uncertain constraints as open questions instead of facts.
- Preserve the reason each constraint was accepted, changed, or rejected.

## Workflow State Authority

Target Doric architecture separates prompt content from workflow transition
authority. `PROMPT.md` remains the canonical prompt-content artifact for Step
01, while the workflow state harness owns canonical phase and approval
transitions in code.

For Step 01, the harness validates readiness to move from prompt ingestion to
PRD generation by checking Prompt Reflection, required-agent proof, open
questions, and prompt-to-PRD alignment approval. `STATE.md` is generated from
that canonical harness state as a durable projection and audit ledger for
agents and humans to inspect.

## Step 01 Flow

```text
Initial user prompt
  |
  v
Prompt Supervisor creates <run>/PROMPT.md
  |
  v
Grounding context is loaded and attached
  |
  v
Clarification Loop
  |
  +-- choose the next clarification lens
  +-- spawn a fresh Question Agent
  +-- read PROMPT.md, grounding context, and question ledger
  +-- produce focused questions or mark the lens complete
  +-- ask the user through the Human Gate Channel
  +-- integrate answers into a versioned prompt-state revision
  `-- repeat until ready, blocked, rejected, or waiting for input
  |
  v
Prompt Reflection checks readiness
  |
  +-- needs_more_questions -> Clarification Loop
  +-- blocked -> Human Gate Channel
  +-- rejected -> stop
  `-- ready -> Extractors
                  |
                  +-- Product requirements section in <run>/PROMPT.md
                  `-- Architecture requirements section in <run>/PROMPT.md
```

The loop relies on a persistent prompt artifact and fresh agents per round.
Fresh agents reduce hidden state and stale assumptions, while `PROMPT.md`
remains the canonical prompt-content artifact. Workflow phase, approval, and
transition state is owned by the harness and projected into `STATE.md`.

## Workflow

1. Initialize the prompt state.
   - Create `<run>/PROMPT.md`.
   - Store the original user prompt.
   - Normalize the first objective without adding hidden assumptions.

2. Load grounding.
   - Attach hard constraints and convention parameters to the prompt state.
   - Record known conflicts and missing grounding decisions.
   - Keep uncertain grounding visible as open questions.

3. Clarify through lenses.
   - The Supervisor chooses the next lens.
   - A fresh Question Agent reads the current state and proposes one to three
     high-impact questions.
   - The Human Gate Channel asks the user.
   - The Answer Integrator proposes a prompt-state revision.
   - The Supervisor accepts, rejects, or sends the revision back for more input.

4. Reflect before extraction.
   - Prompt Reflection checks whether downstream agents would need to guess.
   - It returns `ready_for_extraction`, `ready_with_warnings`,
     `needs_more_questions`, `blocked`, or `rejected`.

5. Extract product and technical needs.
   - Product extraction captures user value, workflows, success criteria, and
     product risks.
   - Technical extraction captures system context, constraints, validation
     expectations, and technical risks.

## Clarification Lenses

| Lens                 | What It Checks                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Product objective    | What outcome the user wants and why it matters.                                          |
| Users and workflows  | Who uses the result and which workflows change.                                          |
| Scope and non-goals  | What is in scope, out of scope, or deferred.                                             |
| Acceptance criteria  | How success will be recognized.                                                          |
| Technical context    | Platforms, packages, integrations, data, and architecture boundaries.                    |
| Validation           | What evidence is expected before completion.                                             |
| Risk and permissions | Destructive actions, third-party services, security, privacy, migrations, and approvals. |
| Grounding            | Hard constraints and convention parameters that govern the run.                          |

A non-trivial run should cover the required lenses instead of asking random or
repetitive questions. Doric should stop early when the prompt is saturated and
continue when blocking gaps remain.

## Prompt-State Revisions

Every accepted change to `PROMPT.md` needs a clear trigger and provenance.

### Revision Triggers

| Trigger                         | Meaning                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `initial_prompt_normalization`  | The first prompt is structured without adding hidden assumptions.               |
| `user_answer_integrated`        | A user answer resolves, narrows, expands, or corrects part of the prompt state. |
| `user_correction`               | The user replaces an earlier interpretation or answer.                          |
| `grounding_conflict_resolution` | A conflict between prompt intent and grounding is resolved.                     |
| `prompt_reflection_followup`    | Prompt Reflection finds a gap and sends Step 01 back to clarification.          |
| `scope_boundary_confirmed`      | The user confirms in-scope or out-of-scope behavior.                            |

### Revision Record

Each revision should record:

- `revision_id`
- `previous_revision_id`
- `trigger`
- `lens`
- `questions`
- `answers`
- `changed_sections`
- `resolved_questions`
- `new_open_questions`
- `grounding_effect`
- `decision_provenance`

The current `PROMPT.md` may be updated in place as the canonical state, but the
revision history must remain readable. Later agents should be able to answer:

```text
What changed?
Why did it change?
Who or what authorized the change?
Which later artifacts depend on it?
```

### Allowed Changes

- Add a user-confirmed objective.
- Narrow or expand scope when the user explicitly says so.
- Convert a user answer into a run-specific hard constraint.
- Convert a user preference into a convention parameter or soft preference.
- Resolve an open question.
- Add a new open question when an answer exposes another ambiguity.
- Mark a grounding conflict as unresolved or resolved.
- Correct an earlier interpretation when the user clarifies it.

### Disallowed Changes

- Inventing a user goal.
- Treating a model guess as a user decision.
- Resolving a product tradeoff without asking the user.
- Silently removing an explicit user requirement.
- Turning tentative grounding into authoritative grounding.
- Designing the implementation before PRD generation.
- Sending missing user intent to PRD Evolution.

## Component Responsibilities

### Prompt Supervisor

The Supervisor coordinates Step 01 and requests phase transitions through the
workflow state harness.

Responsibilities:

- Create the prompt artifact directory.
- Persist the initial prompt.
- Load grounding context.
- Select clarification lenses.
- Spawn fresh question agents.
- Route questions to the user.
- Accept or reject prompt-state revisions.
- Track open questions and resolved decisions.
- Preserve revision history.
- Decide when the prompt is saturated.
- Block when user input or conflict resolution is required.
- Prevent downstream PRD generation until Prompt Reflection passes.
- Submit prompt-to-PRD transition evidence to the workflow state harness so
  `STATE.md` reflects the generated audit trail.

### Grounding Loader

The Grounding Loader reads relevant context before clarification starts.

Outputs:

- Hard constraints.
- Convention parameters.
- Known conflicts.
- Missing grounding decisions.
- Questions that must be answered before downstream work.

It must not invent authoritative constraints. If a constraint is inferred but
not confirmed, it remains a candidate or open question.

### Question Agent

A Question Agent is scoped to one round or lens.

Inputs:

- Current `PROMPT.md`.
- Current grounding summary.
- Selected clarification lens.
- Previous question ledger.
- Round question limit.

Outputs:

- Focused questions.
- The uncertainty each question resolves.
- The downstream risk if the question remains unanswered.
- A recommendation to continue, block, or mark the lens complete.

The Question Agent does not rewrite `PROMPT.md`.

### Human Gate Channel

The Human Gate Channel asks the user for missing information or decisions.

Questions should:

- Prefer one to three questions per round.
- Affect downstream behavior, scope, validation, risk, or grounding.
- Avoid premature implementation detail unless it is a true constraint.
- Include decision impact when useful.
- Stop when user input is no longer needed.

### Answer Integrator

The Answer Integrator proposes prompt-state revisions after user answers.

Responsibilities:

- Add answers to the answer log.
- Update normalized objective, scope, constraints, and open questions.
- Detect contradictions with earlier answers or grounding.
- Preserve uncertainty instead of guessing.
- Record trigger, changed sections, and provenance.

The Supervisor decides whether the proposed revision is accepted.

### Saturation Judge

The Saturation Judge decides whether required lenses are complete and no
blocking gaps remain. "No questions left" means the prompt is ready by contract,
not merely that one agent found no question in one pass.

### Prompt Reflection

Prompt Reflection asks:

- Is the normalized prompt aligned with the user's answers?
- Are hard constraints separated from preferences?
- Are unresolved assumptions visible?
- Are product and technical needs extractable?
- Is there enough information to generate PRD drafts?
- Would a downstream PRD agent be forced to guess?
- Does any conflict require human input before proceeding?

Valid outcomes:

```text
ready_for_extraction
ready_with_warnings
needs_more_questions
blocked
rejected
```

### Product Needs Extractor

Writes the `Product requirements` section in `<run>/PROMPT.md`.

It extracts:

- User goal.
- Target user or stakeholder.
- Desired behavior.
- User workflows.
- Success criteria.
- Non-goals.
- Product constraints.
- Open product questions.
- Product risks.
- Acceptance criteria candidates.

It avoids choosing architecture or inventing behavior not requested or
confirmed.

### Technical Needs Extractor

Writes the `Architecture requirements` section in `<run>/PROMPT.md`.

It extracts:

- Target system or platform.
- Affected surfaces, if known.
- Existing architecture constraints, if available.
- Data, persistence, migration, or compatibility concerns.
- Third-party integrations.
- Security, privacy, permission, and sandbox concerns.
- Validation expectations.
- Tooling constraints.
- Runtime or deployment constraints.
- Open technical questions.

It avoids designing the solution or turning guesses into facts.

## Artifact Contracts

The prompt phase stores its durable state in one run-root artifact.

### `<run>/PROMPT.md`

Purpose: canonical prompt memory and downstream input for PRD generation and
technical design.

Required sections:

- Original prompt.
- Current objective.
- Confirmed scope.
- Confirmed non-goals.
- Users and workflows.
- Product requirements.
- Architecture requirements.
- Hard constraints.
- Convention parameters.
- Validation expectations.
- Risk and permission notes.
- Open questions.
- Answer log.
- Revision log.
- Prompt Reflection status.

### `Product requirements` section

Purpose: product requirements input for PRD draft generation.

Required sections:

- Product objective.
- Target users or stakeholders.
- User-visible behavior.
- Workflows.
- Success criteria.
- Acceptance criteria candidates.
- Non-goals.
- Product risks.
- Open product questions.

### `Architecture requirements` section

Purpose: technical requirements input for downstream design, not a design.

Required sections:

- Technical context.
- Affected system surfaces, if known.
- Architecture constraints.
- Data and persistence concerns.
- Integrations.
- Security and permission constraints.
- Validation constraints.
- Tooling or runtime constraints.
- Open technical questions.

## Stop Rules

Prompt ingestion can stop only in one of these states:

```text
complete:
    PROMPT.md contains product and architecture sections, and Prompt
    Reflection found no blocking gaps.

complete_with_warnings:
    artifacts are written, warnings are explicit, and downstream agents must
    carry them forward.

waiting_for_user:
    a user decision is required before extraction or downstream generation.

blocked_by_grounding:
    a hard-constraint conflict prevents valid continuation.

rejected:
    the request cannot become a valid Doric run under current constraints.
```

Doric must not proceed to PRD generation when:

- Product scope is unresolved.
- Required user decisions are missing.
- Hard constraints conflict.
- Acceptance criteria are absent.
- Technical constraints are unknown in a way that would force guessing.
- Validation expectations are missing for risky work.

## Failure Modes

| Failure Mode                                | Consequence                                                 | Guard                                                                        |
| ------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Raw prompt goes directly to PRD generation  | Drafts solve a guessed problem.                             | Require Prompt Reflection and prompt artifacts before PRD generation.        |
| Long chat is treated as memory              | Downstream agents miss or distort decisions.                | Persist normalized prompt state in `PROMPT.md`.                              |
| Prompt state changes without provenance     | Later agents cannot tell why scope or constraints changed.  | Require revision triggers, changed sections, and decision provenance.        |
| Answer integration silently changes scope   | Clarification becomes unauthorized product decision-making. | Supervisor accepts revisions and asks the user on contradictions.            |
| Fresh agents receive incomplete state       | Rounds repeat or contradict earlier answers.                | Give each round current `PROMPT.md`, grounding summary, and question ledger. |
| Questions are too broad                     | User answers do not reduce uncertainty.                     | Use lens-specific questions tied to downstream risk.                         |
| Preferences are treated as hard constraints | Downstream work becomes overconstrained or invalid.         | Separate hard constraints from convention parameters and preferences.        |
| Hard constraints are treated as preferences | Invalid work reaches PRD generation.                        | Load grounding early and block on conflicts.                                 |
| Technical extraction becomes design         | The PRD phase is biased prematurely.                        | Restrict architecture requirements to constraints and needs.                 |
| Clarification rounds become mechanical      | User is asked redundant questions.                          | Cover distinct lenses and stop when saturation is reached.                   |

## Minimal First Implementation

A first implementation should include:

1. `PROMPT.md` as the canonical prompt state.
2. A deterministic Prompt Supervisor loop.
3. Grounding loading before the first question round.
4. Clarification lenses for product goal, scope, workflow, technical context,
   validation, risk, and grounding.
5. A fresh Question Agent per lens or round.
6. An Answer Integrator that proposes versioned prompt-state revisions.
7. Supervisor acceptance or rejection of prompt-state revisions.
8. A Prompt Reflection gate.
9. Product Needs extraction.
10. Technical Needs extraction.
11. Workflow state harness integration for the prompt-to-PRD transition and
    generated `STATE.md` projection.

Do not start with:

- Automated PRD generation from the raw prompt.
- Broad repository scanning before the user goal is clear.
- PRD Evolution repair of missing user decisions.
- Generated authoritative grounding without confirmation.
