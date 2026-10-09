---
name: git-cloning
description: Clones a Git repository into a deliberate sandbox location and verifies its checked-out identity. Use when a local repository must be created from a remote URL, branch, tag, or commit.
allowed-tools:
  - git
---

# Git Cloning

## Purpose

Create a usable local repository from a remote without overwriting existing workspace content or exposing credentials.

## Use this skill when

- a repository must be cloned from a remote;
- the clone must start at a specific branch, tag, or commit;
- an existing clone must be checked before deciding whether cloning is necessary.

## Do not use this skill when

- the repository already exists and only needs fetching or updating;
- copying an ordinary directory is sufficient;
- authentication has not been configured by the runtime and the remote requires it.

## Procedure

1. Inspect the destination and stop if cloning would overwrite or mix with existing content. Reuse an existing repository only after verifying its remote identity.
2. Run `git` with `clone`, an explicit remote URL, and an explicit destination. Add `--branch` only when the requested ref is known to be a branch or tag.
3. Never place tokens, passwords, credential-bearing URLs, or credential-helper secrets in tool arguments. Use only authentication already provided by the runtime.
4. If an exact commit is required, fetch it after cloning and check it out deliberately. Create a branch when later commits are expected; otherwise a detached checkout may be appropriate.
5. In the cloned repository, inspect `rev-parse --show-toplevel`, `rev-parse HEAD`, the current branch, and concise status. Confirm the result against the requested repository and ref.
6. Move this thread's working directory to the repository root with the `cwd` tool so the rest of the task runs inside the repository. Return it to the workspace root when the task leaves the repository.
7. Treat network, authentication, missing-ref, and non-empty-destination failures as distinct blockers. Do not retry with broader or destructive arguments without evidence.

## Completion

The destination is a valid repository, its `HEAD` and branch state match the request, the worktree is understood, and no credential was included in a tool argument or reported output.
