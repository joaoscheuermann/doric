---
name: thread-inspection
description: Observes direct child threads through their durable events without disturbing their execution. Use when checking on delegated work.
---

# Thread Inspection

## Purpose

Read child thread state and events to stay informed about delegated work without changing it.

## Use this skill when

- reviewing the state or progress of direct child threads;
- deciding whether delegated work is progressing, stuck, or finished.

## Do not use this skill when

- a child result has already arrived as input; read it instead of re-fetching it;
- the child must change course; that is steering, not inspection.

## Procedure

1. Use `list_threads` to see direct child threads and their states; page with `cursor` when more remain.
2. Use `get_thread` with `afterSequence` to read only new persisted events since the last look; keep the highest sequence seen for the next check.
3. Expect events to include reasoning, tool calls, and results. Treat them as observations about the child's work.
4. Prefer fewer inspections: results arrive automatically when a child finishes, so inspect mainly when progress is unclear or a decision depends on interim state.
5. Reading is passive; inspection never replaces replying, and it does not wake or hurry a child.

## Completion

The state of each delegated child is known from its durable events, inspections stayed bounded, and no inspection changed what the child was doing.
