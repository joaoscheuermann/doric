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

1. Use `thread-list` to see direct child threads and their states; page with `cursor` when more remain.
2. Use `thread-get` to read a child's state and, when a prompt has finished, the result of its most recent finished prompt. It never carries the transcript.
3. Reach for `thread-events` only when you need intermediate progress: it returns a bounded page of compact event digests after an exclusive `afterSequence`, honoring `limit` and returning a `nextSequence` that continues the read.
4. Prefer fewer inspections: the result already arrives automatically when a child finishes, so inspect mainly when progress is unclear or a decision depends on interim state.
5. Reading is passive; inspection never replaces replying, and it does not wake or hurry a child.

## Completion

The state of each delegated child is known from its durable events, inspections stayed bounded, and no inspection changed what the child was doing.
