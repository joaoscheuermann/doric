---
name: failure-diagnosis
description: 'Diagnoses a local command, build, test, or runtime failure from reproducible evidence before any fix is attempted. Use when the cause is unknown or diagnostics are noisy.'
allowed-tools:
  - terminal
  - grep
  - find
---

# Failure Diagnosis

## Purpose

Identify the earliest actionable cause of a failure and separate it from downstream symptoms.

## Use this skill when

- a test, build, lint, type-check, or script fails;
- terminal output contains multiple cascading diagnostics;
- the failing component or source file is uncertain.

## Do not use this skill when

- the root cause and exact correction are already established by direct evidence;
- the objective is merely to rerun a known successful command.

## Procedure

1. Reproduce the failure with the smallest command and scope that still fails.
2. Inspect the exit code, the first meaningful diagnostic, and nearby context. Treat later errors as possible consequences until proven otherwise.
3. Search exact error text, symbols, paths, or configuration keys with `grep`; use `find` when a referenced path or generated artifact must be resolved.
4. Inspect the relevant source and configuration through bounded terminal reads.
5. Form one explicit hypothesis that connects the evidence to the failure. Identify what observation would falsify it.
6. Run a narrow confirming command or inspection. Avoid speculative edits during diagnosis.
7. State the root cause, supporting evidence, affected scope, and the smallest plausible correction. If evidence is insufficient, state what remains unknown.

## Completion

A reproducible cause is supported by direct observations, or the investigation ends with a precise blocked reason and next required evidence.
