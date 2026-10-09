---
name: change-validation
description: 'Verifies that a local change satisfies its completion criteria and did not introduce obvious regressions. Use after edits, writes, generated artifacts, or configuration changes.'
allowed-tools:
  - terminal
  - grep
  - find
---

# Change Validation

## Purpose

Turn a completed modification into an evidence-backed result by checking the artifact, behavior, and relevant regressions.

## Use this skill when

- one or more files were edited or written;
- a command changed generated output or configuration;
- the objective has observable acceptance criteria.

## Do not use this skill when

- no local state changed and the result is purely cognitive;
- validation requires unavailable infrastructure and this limitation is already explicit.

## Procedure

1. Translate the goal's completion criteria into the smallest set of observable checks.
2. Verify that expected files and patterns exist and that deprecated or unintended patterns are absent.
3. Re-read changed regions or inspect the diff; a successful tool response alone does not prove semantic correctness.
4. Run the narrowest relevant formatter, parser, test, type check, lint, build, or executable example.
5. Inspect exit codes and diagnostics. Do not report a passing check that was skipped, filtered out, timed out, or truncated beyond interpretation.
6. Escalate from targeted checks to broader checks only when the affected dependency surface justifies it.
7. Record checks that could not run and distinguish verified correctness from residual uncertainty.

## Completion

All available checks tied to the completion criteria pass, the persisted state matches the intended result, and any unverified risk is stated specifically.
