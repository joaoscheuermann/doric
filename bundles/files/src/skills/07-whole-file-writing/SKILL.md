---
name: whole-file-writing
description: 'Creates a new file or deliberately replaces an entire file with complete content. Use when the desired artifact is known as a whole rather than as a local patch.'
allowed-tools:
  - find
  - terminal
  - write
---

# Whole-File Writing

## Purpose

Persist a complete artifact at a known path using one intentional whole-file write.

## Use this skill when

- creating a new source, configuration, documentation, or data file;
- replacing an existing file whose entire desired content has been reconstructed;
- the user explicitly requests a saved artifact.

## Do not use this skill when

- only a small region of an existing file should change;
- preserving unknown existing content is required but the file has not been inspected;
- the requested content should remain only in the response rather than be persisted.

## Procedure

1. Confirm the exact destination path and whether the file already exists.
2. If an existing file may contain content that must be preserved, inspect it before composing the replacement.
3. Produce the complete final content before calling `write`; do not rely on a sequence of partial overwrites.
4. Match the repository's encoding, formatting, naming, and newline conventions when evidence is available.
5. Call `write` once for the complete artifact. Inspect `success`, `bytes_written`, `diff`, and any error.
6. Verify the saved file with a focused read or a command appropriate to its format.

## Completion

The complete intended artifact exists at the requested path and its persisted content has been verified.
