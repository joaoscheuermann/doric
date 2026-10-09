---
name: git-remote-synchronization
description: Fetches and pushes Git refs with explicit upstream, divergence, and force-update checks. Use when local and remote repository state must be compared or synchronized safely.
allowed-tools:
  - git
---

# Git Remote Synchronization

## Purpose

Synchronize local and remote refs without exposing credentials, overwriting unseen work, or confusing fetch, integration, and publication.

## Use this skill when

- remote refs must be fetched or pruned;
- a branch or tag must be pushed;
- upstream tracking or ahead/behind state must be established;
- a rejected push or diverged branch must be diagnosed.

## Do not use this skill when

- the repository has no verified remote;
- authentication is unavailable or must be supplied through tool arguments;
- the request concerns only local commits or worktrees.

## Procedure

1. Inspect configured remotes without reproducing credential-bearing URLs, the current branch, upstream, status, and ahead/behind state. Confirm the intended remote and destination ref.
2. Fetch the relevant remote and prune stale remote-tracking refs when appropriate. Fetching updates observations; it does not integrate local history.
3. Compare local and remote commit ranges. If integration is needed, choose merge or rebase according to repository policy and perform it as a separate, validated step.
4. Before push, require a clean understanding of the commits and refs that will be published. Use an explicit refspec and `--set-upstream` only when creating the intended tracking relationship.
5. Never place credentials in Git arguments, remote URLs, commit messages, or reported output. Use only runtime-provided authentication.
6. Do not force-push by default. When rewriting a remote ref is explicitly approved, fetch immediately beforehand, verify the expected remote tip, use `--force-with-lease`, and never substitute unrestricted `--force`.
7. Verify the resulting upstream and remote ref after a successful push. On rejection, re-fetch and diagnose divergence instead of escalating destructiveness.

## Completion

The intended refs are synchronized and verified, tracking state is correct, no unseen remote work was overwritten, and no credential was exposed.
