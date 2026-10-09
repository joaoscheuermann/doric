---
name: evidence-grounded-synthesis
description: 'Produces a concise answer, explanation, or comparison whose material claims remain traceable to local or web evidence. Use after relevant evidence has been collected from files, commands, or pages.'
allowed-tools:
  - grep
  - terminal
  - web
---

# Evidence-Grounded Synthesis

## Purpose

Transform collected observations into a result without losing provenance, overstating certainty, or mixing facts with inference.

## Use this skill when

- summarizing files, command results, diagnostics, or web pages;
- comparing alternatives using explicit criteria;
- explaining a repository behavior from several local sources;
- reporting findings that include gaps, conflicts, or uncertain interpretation.

## Do not use this skill when

- evidence has not yet been collected;
- the result is a purely creative artifact with no factual claims to support;
- the objective requires a domain procedure not supplied by another skill.

## Procedure

1. Identify the material conclusions required by the current goal and its completion criteria.
2. Group observations by conclusion rather than by tool-call order.
3. For each material claim, preserve the supporting file path and line context, command result, or page URL. Use additional inspection only when support is missing.
4. Separate direct facts, derived conclusions, assumptions, and unresolved questions.
5. Reconcile conflicting evidence by scope, date, version, or authority; do not silently choose one source.
6. Omit incidental details that do not affect the requested result, while retaining limitations that could change interpretation.
7. Present the result in the user's requested format and level of detail.

## Completion

Every material claim is supported or explicitly labeled as inference or uncertainty, and the final result directly answers the objective without reproducing the raw tool trajectory.
