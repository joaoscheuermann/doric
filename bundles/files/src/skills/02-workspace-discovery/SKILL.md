---
name: workspace-discovery
description: 'Maps an unfamiliar workspace and locates plausible files or directories before deeper inspection. Use when the repository structure or target path is uncertain.'
allowed-tools:
  - tree
  - find
---

# Workspace Discovery

## Purpose

Build a small, accurate map of the relevant workspace before reading or changing files.

## Use this skill when

- the target path is unknown;
- the request names a feature, artifact, extension, or directory rather than an exact file;
- several similarly named locations may exist.

## Do not use this skill when

- an exact, verified path is already available;
- the objective is to search file contents rather than filenames or structure.

## Procedure

1. Start with `tree` at the narrowest plausible root. Exclude generated or high-volume directories when they are not relevant.
2. Treat a `tree` result beginning with `Error:` as a failure, not as an empty directory.
3. Use `find` with a targeted glob to locate likely files. Prefer a narrow `path` and pattern over a repository-wide wildcard.
4. Check `total` and `truncated`. If output is truncated, narrow the path or pattern before drawing conclusions.
5. Compare candidates by directory role, filename, extension, and proximity to related files. Do not select a file from its name alone when ambiguity remains.
6. Return the smallest candidate set needed by the next step, including relative paths and the reason each candidate is plausible.

## Completion

The relevant subtree is understood and one verified target path, or a small justified candidate set, is available for inspection.
