---
name: git-worktrees
description: Creates, inspects, moves, and removes Git linked worktrees while preserving branch ownership and local changes. Use when parallel branches need separate working directories.
allowed-tools:
  - git
---

# Git Worktrees

## Purpose

Manage linked worktrees through Git's metadata-aware commands so branches and working directories remain consistent.

## Use this skill when

- another branch needs its own working directory;
- existing linked worktrees or their checked-out branches must be discovered;
- a worktree must be moved, repaired, pruned, or removed.

## Do not use this skill when

- switching the current worktree is sufficient;
- an ordinary copied directory is not intended to share Git object storage;
- removing a worktree would discard uncommitted or untracked content.

## Procedure

1. Run `worktree list --porcelain` from the main repository and inspect status in every worktree that may be changed or removed.
2. Before adding a worktree, choose an explicit path and determine whether to check out an existing branch, create a new branch from an explicit base, or use a detached commit. Confirm that the branch is not already checked out elsewhere.
3. Add the worktree with `worktree add`, using `-b` only for a new branch. Verify its path, `HEAD`, branch, and concise status from the new directory.
4. Move this thread's working directory to the chosen worktree with the `cwd` tool before working in it.
5. Move registered worktrees with `worktree move`; do not move directories manually. Respect submodule and filesystem limitations reported by Git.
6. Remove a worktree only after proving its changes are preserved or intentionally disposable. Use `worktree remove`; do not force removal merely to bypass a dirty-worktree warning.
7. Inspect prune candidates before `worktree prune`. Prune only stale administrative entries, then verify the final porcelain listing.

## Completion

Every affected worktree is registered at the intended path, owns the intended branch or detached commit, preserves required changes, and appears correctly in `worktree list --porcelain`.
