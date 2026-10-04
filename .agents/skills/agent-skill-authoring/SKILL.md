---
name: agent-skill-authoring
description: Guidelines for creating and refactoring Agent Skills optimized for GPT-5.5. Covers the Agent Skills directory structure, YAML frontmatter specification, outcome-first prompting, retrieval budgets, and progressive disclosure rules. Load when scaffolding a new skill or refactoring an existing one.
allowed-tools: read, write, replace, find
---

# Agent Skill Authoring

Use this skill to design, review, or refactor Agent Skills. Your goal is to create skills that comply with the Agent Skills specification while perfectly aligning with GPT-5.5's preference for efficiency, minimal tool loops, and outcome-oriented behavior.

## Success criteria

- **Specification:** The skill has a valid `SKILL.md` with correct YAML frontmatter (name constraints, description length) and proper directory structure.
- **Efficiency:** Reference files are logically consolidated to minimize the number of tool loops required to understand a concept.
- **Prompting:** Instructions are written as outcome-first goals (not rigid, step-by-step checklists).
- **Steerability:** The skill includes an explicit retrieval budget (stopping conditions) telling the agent when it has read enough to act.

## Retrieval & Stop Rules

Resolve uncertainties by reading the specific reference files below. **Do not read every file if you already understand the requirements.**

- Read `agent-skills-spec.md` if you need the strict formatting rules, directory structure, and YAML constraints.
- Read `gpt-5.5-optimizations.md` if you need the prompting guidelines, formatting style, and behavioral rules.
- Once you have enough context to generate the requested skill or refactor the code correctly, stop reading and begin your task.

## Reference index

### Structural Specification

[references/agent-skills-spec.md](references/agent-skills-spec.md)
Contains: Directory structure, `SKILL.md` YAML frontmatter constraints, optional directories (`scripts/`, `assets/`, `references/`), and validation commands.

### GPT-5.5 Optimizations

[references/gpt-5.5-optimizations.md](references/gpt-5.5-optimizations.md)
Contains: Outcome-first prompting, retrieval budgets, minimizing tool loops, replacing legacy prompt constraints (e.g., screaming caps), and formatting guidelines.
