---
name: focused-file-inspection
description: 'Reads a known local file or a bounded line range through shell commands without dumping unnecessary content. Use after a target path or match location has been established.'
allowed-tools:
  - terminal
---

# Focused File Inspection

## Purpose

Read local file content in bounded, reviewable ranges once the target path is known.

## Use this skill when

- inspecting a complete small file;
- reading around a known line, symbol, or diagnostic;
- checking headers, tails, metadata, or nearby code before an edit.

## Do not use this skill when

- the target path is still unknown;
- searching across many files;
- modifying content.

## Procedure

1. Set `working_directory` explicitly when relative paths are used.
2. Check file size or line count before printing a potentially large file.
3. Prefer bounded commands such as `sed -n`, `head`, `tail`, or `nl` around the relevant range. Quote paths.
4. Read enough surrounding structure to understand declarations, control flow, delimiters, and adjacent configuration; do not isolate a line from its semantics.
5. Inspect the terminal `exit_code`, diagnostics, and truncation metadata. An empty compact summary does not prove the file is empty when the command failed or output was truncated.
6. If more content is needed, request the next targeted range rather than dumping the whole repository or a large binary-like file.

## Completion

The relevant content is available with its path and line context, and the next action can be justified from what was actually read.
