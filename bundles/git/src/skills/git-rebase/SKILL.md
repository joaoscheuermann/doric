---
name: git-rebase
description: Rebases a local Git branch onto an explicit base with preflight checks and recoverable conflict handling. Use when local commits must be replayed onto updated history without losing work.
allowed-tools:
  - git
---

# Git Rebase

## Purpose

Move an intentional set of local commits onto a verified base while preserving recoverability and making rewritten history explicit.

## Use this skill when

- a local feature branch must be updated onto another branch or remote ref;
- a non-interactive rebase has stopped and must be inspected, continued, or aborted;
- rewritten commits must be validated before any remote update.

## Do not use this skill when

- the target branch or commit range is ambiguous;
- unrelated working-tree or index changes are present;
- rewriting shared or published history has not been explicitly intended.

## Procedure

1. Inspect the current branch, concise status, upstream, `HEAD`, target base, and commits that would be replayed. Require a clean worktree and index; do not hide changes with an automatic stash.
2. Fetch the relevant remote refs when current remote state matters. Record the starting commit so the previous state can be identified through the reflog if recovery is needed.
3. Run a non-interactive `rebase` onto the explicit target. Do not use interactive rebase unless the requested rewrite has a fully specified todo plan that can be supplied without an editor.
4. If conflicts occur, apply the Git conflict-resolution procedure one commit at a time. Inspect the current commit before resolving, validate resolved content, stage it, and use `rebase --continue`.
5. Use `rebase --skip` only when evidence shows the current commit is redundant. Use `rebase --abort` when the requested rebase cannot be completed safely or the user chooses to restore the starting state.
6. After completion, compare the new commit range with the recorded old range, inspect status, and run relevant validation. Treat pushing rewritten history as a separate remote-synchronization decision.

## Completion

The branch is cleanly rebased onto the intended base, its rewritten commits preserve the requested change, validation passes, and any required remote rewrite remains explicit rather than automatic.
