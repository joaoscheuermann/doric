> Record (2026-11-20). This document is kept as a record and does not describe current behavior; the living description is [docs/features/context-compaction.md](../../features/context-compaction.md).

# Context compaction

**Status:** implemented in `feat/context-compaction`. This document describes the implemented behavior and the plan that guided it; the root `AGENTS.md` remains the validity contract, and the section "Feature-complete criteria" lists what "complete" means in this landing.

## Summary

Context compaction is the condensation of a Thread's old history into a single summary message: the provider-ready history (`direct.history/v1`) is rewritten to keep the summary in place of the old span, the recent tail stays intact, and the conversation continues as if the summary had always been there. The condensed content is not lost: the Thread's events remain in the log and the conversation in the UI keeps rendering the full feed, now with a mark at the compaction point.

The plan uses DeepSeek's `dsh-compaction` contract (`deepseek-ai/deepseek-harness`, `packages/compaction`) as a reference for vocabulary and guarantees — log-only bracket, surface mutated only once, safe tool-pairing boundaries, stable marker — translated into the pieces doric already has.

## Translating the DeepSeek model to doric

DeepSeek describes a _seam_ (`ctx.compaction`) over a session whose model-visible surface is derived by replaying an event log. In doric the relation is inverted and simpler:

- the Thread's **event log** (stream `runtime.thread.events/<threadId>`) is the complete record — it is what the UI renders;
- the **model surface** is the stored provider-ready history, `direct.history/v1` (parts `messages` + `meta`), opaque to the `runtime` and owned by the `direct` executor.

So the doric equivalent of `surfaceOp: replace` is the **rewrite of the `messages` part** (plus the re-base of the `meta` part), written through the same `PromptSession` that the rest of the executor uses — which already guarantees commit-before-publish, redaction, and the storage-pause retry.

| DeepSeek `dsh-compaction`                                               | doric                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompactionEngine` (abstract seam on `ctx.compaction`)                  | `compact` method of the `executor/v1` seam; the policy lives in the `direct` executor                                                                                                                                  |
| Session log + `deriveMessages()`                                        | Thread event log (UI) + `messages` part of `direct.history/v1` (model)                                                                                                                                                 |
| `compaction/start` log-only (the bracket is the lock)                   | `compaction.started` event recorded **before** any rewrite; the `started`/`finished` pair is the bracket                                                                                                               |
| `compaction/summary` log-only + one `user/message` with `surfaceOp`     | `compaction.finished` event (with result) in the same `record()` that writes the history patch                                                                                                                         |
| `compaction/end` releases the lock                                      | included in `compaction.finished` (one event, one commit)                                                                                                                                                              |
| `compaction/summary-error` + `ManualCompactionError` with closed `code` | a post-bracket failure records `compaction.failed` with a `code` from a closed set and, since `executor/v1` 1.5.0, an optional `error`; pre-bracket refusals (`busy`, `disabled`, `nothing_to_compact`) record nothing |
| `toolPairingBalancedBefore/After(session, seq)`                         | `safeBoundary(messages, index)`: no assistant tool call without a response crossing the cut                                                                                                                            |
| Checkpoint marker exported from a Cordis-free subpath                   | `isCompactionCheckpoint(message)` + constant `checkpointMarker`, with no dependencies beyond types                                                                                                                     |
| `compactIfNeeded` (pressure/overflow), `compactNow`, `compactRegion`    | `maybeCompact` (automatic), `compactThread` (on-demand, condenses everything condensable), no explicit `compactRegion` (deferred)                                                                                      |
| `tokenMeter` separate service                                           | `UsageMetadata` from provider events + `contextWindow` from `response.started`/catalog; estimated projection, no new service                                                                                           |
| `/compact` (human command)                                              | `POST /threads/:id/compact` (transport) → `runtime` service → executor; refuses `busy`                                                                                                                                 |
| `compaction-basic` backend (summary written by the model)               | `direct` summarizer: same `models/v1` as the run, signal propagated, output in readable Markdown                                                                                                                       |
| tool-result pruner, image offload                                       | **not** in this landing (known limitations)                                                                                                                                                                            |

Deliberate differences:

- **Lock by runner state, not by log inspection.** DeepSeek detects an orphaned bracket by rescanning the log; in doric, one prompt run per Thread is already serialized by the runner (queue + `thread.active`), and on-demand compact requires an idle Thread under the project's mutation lock. The bracket in the log still exists, as evidence and as a UI mark, and a `compaction.started` without `finished` in the log is a readable sign of an interrupted execution.
- **Write order.** DeepSeek writes `start` → summary → surface → `end`. doric writes `compaction.started` (event), then **a single** `record()` with the history patch + `compaction.finished`. A crash between the two leaves the bracket open in the log and the history **intact** — the same guarantee as DeepSeek, with the history as a single document and not a replay.
- **Rewind.** DeepSeek has no rewind; doric does. Checkpoints of prompts whose boundary fell inside the condensed span are discarded: a rewind to those prompts now answers `unknown_prompt` (the summary is not undone). Surviving checkpoints are re-based by the delta of removed messages.

## Implemented contract

### Checkpoint marker

The summary message is a message with role `user` whose content starts with the stable line `checkpointMarker` (exported constant, recognized by `isCompactionCheckpoint`). The marker is text, survives persistence, serialization and providers, and follows the human-readable prompt rules (HC-010).

### Events (log-only for the surface)

- `compaction.started` — payload `{ trigger: 'automatic' | 'manual' }`.
- `compaction.finished` — payload `{ summaryId, condensedMessages, retainedMessages, tokensFreed, summaryChars }`.
- `compaction.failed` — payload `{ code, error? }`, only for a failure **after** the bracket opens; `error` (since `executor/v1` 1.5.0, optional) holds the failure behind the code, which the chat's compaction row shows in an error notice with the code and the cause.

Closed codes: `summarizer_failed`, `unsafe_boundary` (unexpected post-selection failure). Pre-bracket refusals record no event: `busy`, `disabled`, `nothing_to_compact`, `missing_history`.

### Safe boundaries

A cut between messages `i` and `i+1` is safe when no assistant tool call is left with its request on one side and its response on the other. The end of the condensed span is the largest safe boundary that respects the minimum tail (`tailMinMessages`); if the required tail finds no safe boundary, nothing is condensed (limitation inherited from DeepSeek: an indivisible unit is not split).

### Automatic trigger

After each `response.finished`/`usage` of a run, the executor projects the next call:

- `contextWindow` known (`response.started` event or catalog): `projected = últimoInputTokens + últimoOutputTokens + promptPendenteEstimado`; pressure when `projected / contextWindow ≥ pressurePercent` (default 80).
- `contextWindow` unknown: projection by characters (`≈ tokens = chars/4`) against `pressurePercent` of the configurable ceiling `charBudget` (default 200_000).

In both cases `tokensFreed` is an estimate and the result says so. When the projection indicates pressure but there is no condensable span that frees enough, the compaction does not run (known limitation: single-unit overflow out of contract, as in DeepSeek).

### Manual trigger

`POST /threads/:id/compact`: idle Thread → `executor.compact` condenses the whole condensable span up to the largest safe boundary above the minimum tail. Thread with an active run or queued jobs → refuses `busy` without writing anything (mirrors `rewind`). Delegated threads use the same path, because they share the executor.

### Provider overflow

When the provider fails with an error classified as a context overflow (textual heuristic documented in `isContextOverflow`, via the stream's `error` event or the run's exception), the executor runs the emergency compaction of the history — `force: true`, without depending on the projection — so that the next resumption starts condensed, and lets the run's error propagate as today. Retrying the turn within the same run does not exist yet (declared limitation).

## Implemented phases

1. **Pure core** (`bundles/runtime/default/src/host/compaction/`): `markers`, `boundaries`, `rewrite` (span selection, checkpoint re-base, meta), `project` (pressure projection), `summarize` (backend), `compact` (orchestration with bracket and codes). Unit tests for each one.
2. **Contract** (`bundles/runtime/runtime/src/contracts/executor.ts`): `compact` method of the `Executor` (input: `thread`, `session`, `policy`; closed output) — the `runtime` still does not know `llms`.
3. **Automatic executor** (`bundles/runtime/default/src/host/executor.ts`): capture of `usage`/`contextWindow` in the stream, pressure check after writing the turn's state, compaction between turns, and overflow interception.
4. **On-demand** (`runtime` services/runner/domain + `transport`): route `POST /threads/:id/compact`, `busy` refusal, synthetic session with its own `promptId`, publication of the events.
5. **Configuration** (`bundles/foundation/host-config`): optional `contextCompaction` section with defaults; read by the executor.
6. **UI** (`bundles/desktop/chat`): projection of the bracket as its own `compaction` turn (discreet row, lifecycle style), read-only and undeletable.
7. **Documentation and validity**: this document, the documentation (sections on events and session persistence), and tests.

## Feature-complete criteria for this landing

The feature is complete when **all** of these items are verifiable in the repository:

1. Automatic compaction condenses the history between turns of a run when the projected pressure crosses the threshold, writing bracket + patch in two `session.record()` calls following the executor's pattern.
2. `POST /threads/:id/compact` condenses on demand on an idle Thread and refuses `busy`/`missing`/`inactive` without writing events.
3. The summary is recognizable by a stable marker and never splits a tool-call/result pair.
4. Checkpoints are re-based; a rewind to a prompt whose boundary was condensed answers `unknown_prompt`.
5. The three event types exist in the log with closed payloads and the UI renders the bracket as its own turn.
6. `contextCompaction` config (enabled, pressurePercent, tailMinMessages, summaryMaxChars, charBudget) with safe defaults; when disabled, nothing compacts.
7. Tests: pure core, re-base/rewind, marker, boundaries, projection, summarizer (fake provider), automatic executor (fake stream), service/runner (refusals), UI projector.
8. The documentation and this document consistent with the code; lint and tests of the affected packages passing.

## Known limitations (inherited and declared)

- A human command via the settings/slash surface does not exist; the manual trigger is the workspace's HTTP route (the slash-commands architecture is outside the repository's current scope).
- No `compactRegion` with an explicit range (DeepSeek also keeps it out of the human command).
- No tool-result pruner or image offload; an indivisible unit larger than the window is not condensable.
- No in-run retry of the turn after overflow; the emergency compaction prepares the next resumption.
- The envelope that on its own approaches the window (system prompt, tools) is not surface-compaction work — the same as DeepSeek.
