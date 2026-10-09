---
name: git-commit-preparation
description: Prepares and creates a focused Git commit from verified changes. Use when repository changes must be reviewed, selectively staged, validated, committed, and confirmed without absorbing unrelated work.
allowed-tools:
  - git
---

# Git Commit Preparation

## Purpose

Turn an intended change into one reviewable commit while preserving unrelated tracked, staged, and untracked work.

## Use this skill when

- changes are ready to be committed;
- an existing index must be inspected before staging more work;
- a commit must contain only the files or hunks belonging to the current objective.

## Do not use this skill when

- the request is only to inspect or explain changes;
- validation is still failing or the intended diff is uncertain;
- author identity or commit policy is missing and requires a human decision.

## Procedure

1. Inspect `status --short --branch`, the unstaged diff, the staged diff, and relevant untracked files. Distinguish pre-existing staged content from changes for the current objective.
2. Validate the intended change with the repository's narrowest reliable checks before committing.
3. Stage explicit paths with `add -- <paths>`. Avoid broad staging such as `add -A` unless every discovered change is intentionally in scope. Use patch staging only when the non-interactive environment can represent the exact selection safely.
4. Reinspect `diff --cached --stat` and `diff --cached`. Remove unrelated paths from the index without discarding their working-tree content.
5. Confirm that Git author identity is available. Do not invent or persist a user name, email, signing choice, or credential.
6. Create a non-interactive commit with a concise message that describes the actual staged change. Do not amend or rewrite an existing commit unless explicitly requested.
7. Verify the new commit with `show --stat --oneline HEAD` and inspect status again for remaining work.

## Completion

One commit contains exactly the intended validated changes, its identity and message are confirmed, and all unrelated or remaining work is still visible and preserved.
