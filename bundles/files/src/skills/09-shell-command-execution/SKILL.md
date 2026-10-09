---
name: shell-command-execution
description: 'Runs bounded, non-interactive shell commands and interprets compact terminal results correctly. Use for builds, tests, formatters, package scripts, version control inspection, and local transformations.'
allowed-tools:
  - terminal
---

# Shell Command Execution

## Purpose

Execute one well-scoped shell operation and evaluate its observable result rather than inferring success from partial output.

## Use this skill when

- running tests, linters, type checks, builds, formatters, package scripts, or version-control inspection;
- using a standard command-line program to inspect or transform local data;
- no dedicated tool expresses the operation more precisely.

## Do not use this skill when

- `find`, `grep`, `edit`, `write`, or `web` directly matches the operation;
- the command is interactive, indefinitely long-running, or starts an unattended background service unless that effect is explicitly required.

## Procedure

1. Select the narrowest command that can produce the required observation or effect.
2. Set the correct `working_directory`; do not rely on an assumed current directory.
3. Use a finite `timeout_ms` appropriate to the command. Prefer targeted test files or packages before repository-wide commands.
4. Keep unrelated operations separate so each exit code remains interpretable. When every step in a compound command is required, use `set -e` or join steps with `&&`; otherwise a later successful step can hide an earlier failure in the final exit code.
5. Inspect `success`, `exit_code`, stdout, stderr, diagnostics, duration, and truncation. A familiar-looking tail is not sufficient evidence of success.
6. If output is truncated, rerun a narrower diagnostic command or use the raw reference when the runtime supports it.
7. Do not modify files through ad hoc shell redirection when `edit` or `write` provides a clearer contract.

## Completion

The command ran in the intended location, its status and diagnostics were interpreted correctly, and the result directly supports the current goal.
