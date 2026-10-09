---
name: multi-file-consistency
description: 'Maintains one explicit invariant across multiple existing or new files. Use for coordinated renames, configuration changes, API migrations, or repeated documentation updates.'
allowed-tools:
  - find
  - grep
  - edit
  - write
  - terminal
---

# Multi-File Consistency

## Purpose

Apply a coordinated change across all causally affected files without blind repository-wide replacement.

## Use this skill when

- renaming a symbol, command, field, route, or configuration key;
- updating declarations and their consumers together;
- introducing a new file while adapting existing references;
- an objective requires the same invariant to hold in several locations.

## Do not use this skill when

- only one verified file is affected;
- matches share text but not meaning;
- the expected invariant has not been stated clearly.

## Procedure

1. State the invariant before editing, including what must change and what must remain compatible.
2. Use `grep` and `find` to enumerate candidate locations. Classify each match before modifying it.
3. Trace dependencies where necessary to distinguish causal consumers from comments, fixtures, generated output, or unrelated names.
4. Use `edit` for localized changes and `write` only for new files or intentional whole-file replacement.
5. Re-run searches for the old pattern, missing new pattern, and inconsistent variants. Explain any intentionally retained occurrence.
6. Run targeted checks for the affected area, then broader checks only when justified.
7. Review the aggregate diff for accidental scope expansion.

## Completion

The stated invariant holds across all verified affected files, retained exceptions are justified, and relevant checks pass.
