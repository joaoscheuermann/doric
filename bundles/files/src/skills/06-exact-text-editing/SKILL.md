---
name: exact-text-editing
description: 'Applies minimal changes to existing files through unique exact-text replacements. Use when the target content is known and preserving unrelated text matters.'
allowed-tools:
  - edit
  - grep
  - terminal
---

# Exact Text Editing

## Purpose

Modify existing files with the smallest reviewable replacement while preserving unrelated content.

## Use this skill when

- changing a known block, declaration, value, import, or paragraph;
- several independent exact replacements belong in the same file;
- a diff should make the intended change explicit.

## Do not use this skill when

- creating a new file;
- intentionally replacing nearly all of a file;
- the current file contents have not been inspected or may have changed.

## Procedure

1. Read the current target region immediately before editing.
2. Choose `oldText` that matches exactly one region. Include enough stable surrounding context to make it unique, but no unrelated content.
3. Keep replacements non-overlapping. Batch only independent edits whose exact targets have all been verified.
4. Preserve indentation, line endings, syntax, and local conventions in `newText`.
5. If the tool reports ambiguity or no match, re-read the file and construct a new exact target. Do not guess from stale content.
6. Inspect `success`, `diff`, and `first_changed_line`. Verify the changed region with a focused read or search.
7. When the change has behavioral consequences, combine this skill with validation rather than treating a successful replacement as proof of correctness.

## Completion

Every intended replacement appears exactly once, unrelated content is unchanged, and the resulting file remains structurally coherent.
