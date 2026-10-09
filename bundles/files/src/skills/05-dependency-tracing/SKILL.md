---
name: dependency-tracing
description: 'Traces how a local symbol, file, configuration value, or command participates in a larger implementation. Use when a change or explanation depends on imports, callers, registrations, or tests.'
allowed-tools:
  - grep
  - find
  - tree
  - terminal
---

# Dependency Tracing

## Purpose

Construct the smallest evidence-backed dependency chain needed to explain behavior or scope a change.

## Use this skill when

- following a symbol from declaration to callers or consumers;
- locating registrations, entry points, configuration, tests, or generated boundaries;
- determining which files are causally affected by a proposed change.

## Do not use this skill when

- a single isolated file fully determines the result;
- the objective only requires a filename or a literal match.

## Procedure

1. Start from a verified anchor: an exact symbol, file, configuration key, command, or runtime diagnostic.
2. Use `grep` to locate definitions and references, then classify each match by role.
3. Use `tree` or `find` to understand module boundaries and locate adjacent manifests, tests, or entry points.
4. Inspect only the relevant ranges with `terminal`; follow imports, exports, calls, registrations, and data flow one edge at a time.
5. Record direct evidence separately from inference. Naming similarity is not proof of dependency.
6. Stop at the boundary needed by the current objective. Do not map the entire repository when a shorter causal chain is sufficient.

## Completion

A minimal chain of relevant files and relationships is established, with uncertainty or unresolved dynamic behavior stated explicitly.
