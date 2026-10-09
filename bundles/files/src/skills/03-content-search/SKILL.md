---
name: content-search
description: 'Locates symbols, configuration keys, messages, and exact text inside workspace files. Use when the target is known by content rather than by path.'
allowed-tools:
  - grep
  - find
---

# Content Search

## Purpose

Find the smallest set of content locations that can answer the current question or identify the next file to inspect.

## Use this skill when

- locating a symbol definition or usage;
- finding configuration keys, error messages, routes, commands, or literal text;
- checking whether an old or new pattern still exists after a change.

## Do not use this skill when

- only filenames or directory structure matter;
- a complete file must be read sequentially;
- the next action is already known from a verified exact location.

## Procedure

1. Choose literal matching for exact identifiers, messages, and punctuation-heavy text. Use regular expressions only when pattern variation is intentional.
2. Narrow the search with `path` and `glob` whenever the likely scope or file type is known.
3. Request only enough `context` to interpret each match. Avoid large context windows as a substitute for reading a file deliberately.
4. Use case-insensitive matching only when case is not semantically meaningful.
5. Inspect `total`, `truncated`, and `lines_truncated`. Narrow or split the search when the result is incomplete.
6. Distinguish definitions, imports, references, tests, generated output, and comments before deciding which match matters.
7. Use `find` only when a content result reveals a filename pattern that should be resolved structurally.

## Completion

Relevant matches are identified with file paths, line numbers, and sufficient context to support the next decision.
