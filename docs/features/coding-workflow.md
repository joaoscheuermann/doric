# Feature: coding workflow

- Status: `implemented`
- Brief: none
- Specs: [docs/designs/coding-workflow-skill.md](../designs/coding-workflow-skill.md)
- Decisions: [Workflow de código como skill sob demanda (DORIC-91, 2026-10-28)](../architecture/bundles/implementation-decisions.md#workflow-de-código-como-skill-sob-demanda-doric-91-2026-10-28)

## Problem

The coordinator needs the coding workflow for a coding task at a repository root, and a Thread that runs as an agent must not run it: its instructions are its workflow.

## Decisions

- T1: the `default` bundle's coding-workflow hook is removed — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- T2: the workflow is a built-in skill loaded on demand, routed only by its description — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- T4: the system prompt tells the model to load the matching skills; the host does not verify it — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- U1: a Thread checks its directory with `cwd` before working on code — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- U2: a Thread with `agent` does not get the skill — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- U3: histories that hold a retained `default:coding-workflow` instruction are left as they are — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- U6: the skill has `order: 50` — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- U7: delivery relies on the model, with the accepted risks — [spec](../designs/coding-workflow-skill.md#risks).
- U8: the `coding-workflow` entry is pinned in the "Loaded skills" message — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- D9: the executor drops the skill from the run's built-in skills for a Thread with `agent` — [spec](../designs/coding-workflow-skill.md#design-decisions).
- D10: the pin and the `CODING_WORKFLOW_SKILL` constant — [spec](../designs/coding-workflow-skill.md#design-decisions).
- D12: existing retained `default:coding-workflow` messages stay in place — [spec](../designs/coding-workflow-skill.md#design-decisions).

## Current behavior and contracts

- The workflow is the `coding-workflow` built-in skill of the `default` bundle, [bundles/runtime/default/src/skills/coding-workflow/SKILL.md](../../bundles/runtime/default/src/skills/coding-workflow/SKILL.md), which holds its text. It is not always-available and has `order: 50`, so it is the first row of the built-in "Skills to load" list; always-available skills whose bodies pass the 16 000-character budget become rows ahead of it. Its description: "Coordinates a coding task in a Git repository through the built-in triage, search, spec, review, plan, contracts, tests, implementation, cleanup and docs agents. Use when you receive a coding task as a <user-request> and your working directory is a Git repository's root; not when you are a delegated step."
- For a Thread without `agent` the skill is listed in `# Skills` and `load_skill` loads it. For a Thread with `agent` the executor drops it from the run's built-in skills right after reading them (`bundles/runtime/default/src/host/executor.ts`), so it is not listed and `load_skill` refuses it with the unknown-id error.
- The "Loaded skills" message written by compaction pins the entry named by `CODING_WORKFLOW_SKILL` (`bundles/runtime/default/src/host/skills/loaded.ts`): it comes first and is never omitted for the size cap; other entries fill the rest of the cap as before.
- The host neither pushes the workflow nor checks that the model loaded it. The system prompt's `# Instructions` tell the model to check its working directory with the `cwd` tool before working on code and, when the result reports a repository root, to load the skills that match its work; the `cwd` result at a root carries the same reminder ([cwd tool](cwd-tool.md)).
- Retained `default:coding-workflow` instructions written before this change stay in the histories that hold them; compaction keeps them as any retained message.

## Evolution

- 2026-10-20: the workflow is pushed once per Thread as a retained instruction ([PR #33](https://github.com/joaoscheuermann/doric/pull/33)).
- 2026-10-28: the coordinator-only workflow with routes ([DORIC-70](https://linear.app/doric/issue/DORIC-70)).
- 2026-10-28: the workflow becomes the on-demand `coding-workflow` skill, with the agent filter and the pin (DORIC-91, [spec](../designs/coding-workflow-skill.md)).
