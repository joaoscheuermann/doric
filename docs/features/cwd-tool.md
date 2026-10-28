# Feature: cwd tool

- Status: `implemented`
- Brief: none
- Specs: [docs/designs/coding-workflow-skill.md](../designs/coding-workflow-skill.md)
- Decisions: [Workflow de código como skill sob demanda (DORIC-91, 2026-10-28)](../architecture/bundles/implementation-decisions.md#workflow-de-código-como-skill-sob-demanda-doric-91-2026-10-28)

## Problem

Each Thread has one working directory, moved by the model or by the user, and the model must know when that directory is a repository root.

## Decisions

- T3: the `cwd` result, not the system prompt, reports a repository root and the reminder, so the system prompt stays cacheable — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- T5: a move into a repository during a run is reported by the same result — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- U4: the repository fact comes from `runtime.workspace/v1.location()` — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- U5: the result keeps the `note` with its exact text — [spec](../designs/coding-workflow-skill.md#decisions-already-made).
- D3: `repositoryRoot` on every status, `note` only at a root — [spec](../designs/coding-workflow-skill.md#design-decisions).
- D4: root only; a subdirectory of a repository is not a root — [spec](../designs/coding-workflow-skill.md#design-decisions).
- D5: the tool reports a boolean, `location()` answers `CwdRepo` — [spec](../designs/coding-workflow-skill.md#design-decisions).
- D6: every call reads `location()`, which probes now — [spec](../designs/coding-workflow-skill.md#design-decisions).
- D7: `runtime.workspace/v1` 1.2.0 adds `location()` only — [spec](../designs/coding-workflow-skill.md#design-decisions).
- D8: the probe's 5000 ms timeout and `HintProbeIncompleteError` — [spec](../designs/coding-workflow-skill.md#design-decisions).

## Current behavior and contracts

- Tool `cwd` of the `files` bundle ([bundles/features/files/src/host/tools/cwd.ts](../../bundles/features/files/src/host/tools/cwd.ts)). Input: `{ path?: string }`. Without a path (or a blank one) it reports; with one it moves, resolving a relative path against the current directory.
- Output, keys in this order: `cwd` (string), `status` (`reported`, `set` or `refused`), `reason` (refusals only: `outside`, `missing` or `not-directory`), `repositoryRoot` (boolean, every status), `note` (only when `repositoryRoot` is true). The note's text is exactly `Remember to load the skills that match your task when working in a repository.`
- `repositoryRoot` is true only when the working directory itself holds a `.git` directory or file; a subdirectory of a repository is not a root. On a refusal the Thread did not move, and `cwd` and `repositoryRoot` describe the unchanged directory.
- After every outcome — report, move or refusal — the tool calls `runtime.workspace/v1.location()` once, so `cwd` and `repositoryRoot` describe the directory the Thread is in after the call. A rejection of `location()` fails the tool call.
- `runtime.workspace/v1` 1.2.0 adds `location(): Promise<CwdLocation>`, with `CwdLocation = { cwd: string; repo?: 'git' | 'github' }`. It probes the hint now when the Thread holds a sandbox lease and is not closing; otherwise it answers the stored hint without probing. When the probed hint differs from the stored one it writes it to the Thread record, publishes a Thread update and fires `onThreadCwdChangedHook`, so a caller that polls causes those writes. `cwd()`, `setCwd()` and `withThread()` do not change.
- The hint probe passes `timeoutMs: 5000` to its sandbox exec. A probe that does not finish rejects: an exec error (a timeout included) passes through, and a non-zero or `null` exit throws `HintProbeIncompleteError`. Every refresh path then keeps the stored hint — `location()`, the refresh after a job settles, a Git summary read and `withThread({ refreshHint: true })` (used by every `git.commands/v1.status`) — so the `cwdRepo` the desktop sidebar reads is not cleared by an incomplete probe.
- Move outcomes, the same for the `cwd` tool and `PATCH /threads/:id`: a probe that exits 0 stores its hint; one that exits non-zero or `null` stores no hint and the move succeeds; an exec that throws, or times out (5000 ms on firecracker, at most 15 000 ms on docker), makes the move reject.

## Evolution

- 2026-10-18: the tool reports and moves the Thread's working directory ([PR #21](https://github.com/joaoscheuermann/doric/pull/21)).
- 2026-10-28: the result reports `repositoryRoot` and the `note`, through `runtime.workspace/v1.location()` 1.2.0, with a bounded probe (DORIC-91, [spec](../designs/coding-workflow-skill.md)).
