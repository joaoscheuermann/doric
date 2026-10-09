---
name: git-conflict-resolution
description: Resolves Git merge, rebase, cherry-pick, or revert conflicts from stage evidence and validates the combined result. Use when Git reports unmerged paths or an operation has stopped for conflicts.
allowed-tools:
  - git
---

# Git Conflict Resolution

## Purpose

Resolve unmerged paths according to the intended combined behavior, not merely by removing conflict markers.

## Use this skill when

- `status` reports unmerged paths;
- a merge, rebase, cherry-pick, or revert is paused for conflict resolution;
- index stages must be compared before deciding the final content.

## Do not use this skill when

- Git has not reported a conflict;
- choosing one side would require unavailable product or domain intent;
- the user asked only for diagnosis and not mutation.

## Procedure

1. Identify the active Git operation and list unmerged paths with status and `diff --name-only --diff-filter=U`. Do not start a different history operation while one is active.
2. For each path, inspect the working file, conflict hunks, and relevant index stages (`:1:`, `:2:`, and `:3:`) when available. Account for rename/delete, add/add, submodule, and binary conflicts explicitly.
3. Determine the required combined behavior from surrounding code, tests, and the commits being integrated. Do not choose `ours` or `theirs` mechanically; their meaning also changes during rebase.
4. Edit or remove each path to express the intended result, then search for remaining conflict markers. Stage only resolved paths with `add --` or `rm --`.
5. Recheck unmerged paths and both staged and unstaged diffs. If intent remains ambiguous, stop and request the missing decision instead of guessing.
6. Run focused validation before continuing. Resume the active operation with its matching `--continue` command; use `--skip` only when the commit is proven redundant and `--abort` only when abandoning the operation is intended.
7. After Git finishes, run the relevant validation again and inspect status and recent history.

## Completion

No unmerged paths or conflict markers remain, the active Git operation completed or was deliberately aborted, and the integrated behavior passes the applicable checks.
