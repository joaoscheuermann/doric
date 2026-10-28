---
# The routes, Brainstorm, the review stages and checkpoints, and Documents adapt the
# Elephant-Goldfish Model (https://github.com/google/elephant-goldfish-model, commit 3d0b348),
# Copyright 2026 Google LLC, Apache License 2.0.
name: coding-workflow
description: Coordinates a coding task in a Git repository through the built-in triage, search, spec, review, plan, contracts, tests, implementation, cleanup and docs agents. Use when you receive a coding task as a <user-request> and your working directory is a Git repository's root; not when you are a delegated step.
order: 50
---

# Coding in a repository

Deliver a coding task in a Git repository through the workflow below, working from the repository's root.

## Roles

- **Coordinator**: the thread that receives the task as a <user-request>. It runs the workflow and does none of its steps itself: it starts one agent per step, reads each result, and decides what comes next. Only the coordinator asks the user.
- **Steps**: triage, search, spec, review, plan, contracts, tests, implementation, cleanup and docs, each done by the built-in agent of that name.
- If your input is a <parent-instruction>, you are a delegated step: do that instruction and return its result; do not run this workflow.

## Tools

Make a trivial change yourself with edit and write; leave every other change to the steps. Git stays inspection-only: never commit, push or switch branches.

## Routes

- Start every task with triage, giving it the request as written. Choose the route yourself from its evidence: any large-change signal triage reports makes the change large, even when it recommends small; when in doubt, take the large route or ask the user. When plan returns "large change", switch to the large route. A change never moves from large to small.
- Small route: triage, search — skipped when triage's findings already answer what plan needs — plan, contracts, tests, implementation, cleanup, docs.
- Large route: triage, search, spec, the review stages and the user's approval, then plan, contracts, tests, implementation, cleanup, docs.

### Brainstorm

When triage reports an unclear idea, before choosing a route:

1. Ask the user what refines the idea — the problem, who it serves, the constraints, how it is handled today and how success is measured — until its goal, users and scope are clear.
2. Have spec write the concept.
3. Have new review agents attack it in parallel with the Scope, Critique and Comprehension lenses, and send their findings to the same spec agent with thread-send.
4. Give the user the concept's path and the open objections, and ask whether to implement it. If not, stop: the concept stays proposed. If so, have the spec agent mark it accepted, and choose the route.

### Review stages

On the large route, after search, have spec write the spec, then review it in stages, each lens in a new review agent:

1. Scope.
2. Comprehension, Critique, Structural and Style, in parallel.
3. Scope again, on what changed since stage 1.
4. Readiness and Codebase, in parallel.

Give a review agent only the repository path, the document's path and its lens: a thread that has seen the conversation or the writing never reviews.

After each stage, give the user its findings by severity and ask how to continue: resolve them with the spec agent (recommended; send the findings with thread-send), go to the next stage, edit the spec themselves, or pause. Repeat a stage at most once.

After the last stage, ask the user to approve the spec. Start plan only after an explicit approval: silence, or a choice to go to the next stage, is not one.

### Docs

Every route ends with docs, even when nothing needs updating. Then run a review with the Docs lens, giving it the changed files and the spec's path: always on the large route, and on the small route only when docs changed files. Send its documentation findings to a new docs agent and its drift to a new implementation agent.

## Documents

Use the repository's documentation conventions. Where it has none, use only a feature doc (docs/features/<feature>.md) and a spec (docs/designs/<topic>.md), and no other kind of document.

## Coordination

- Start each step with thread-spawn, `agent: <name>`, the effort below, and the title `<Type>: <subject>`.

| Agent                                  | Effort |
| -------------------------------------- | ------ |
| triage, search, cleanup, docs          | low    |
| plan, contracts, tests, implementation | medium |
| spec, review                           | high   |

- Write each instruction to stand alone: the objective, the repository path, the results it depends on, the files it may change, what it must not do, the command that proves its work, and what to return. Give search triage's findings; plan the approved spec's path; tests the plan's test list; tests and implementation the contracts verbatim; cleanup the changed files; docs the changed files, the spec's path and the feature docs triage named.
- Scale the work to the task: one search for a change in one area, several only for independent areas, each with a distinct question. Start a step only after the results it depends on arrive.
- When tests do not fail, or implementation or cleanup reports a failure, start a new agent of the same name with the concrete finding; do not fix it yourself. When an agent reports that the plan is wrong, go back to plan.
- Finish with the outcome and the evidence the steps returned — the commands run and their results — and end with the line `Route: small|large — <reason>`.
- Trivial change — one confined to a single place that needs no design decision, such as a typo or a one-line fix: skip the workflow, triage included. Make it yourself, verify it, and leave out the Route line.
