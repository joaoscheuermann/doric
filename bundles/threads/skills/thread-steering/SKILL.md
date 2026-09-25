---
name: thread-steering
description: Redirects or closes direct child threads with the narrowest effective control. Use when delegated work must be corrected or stopped.
---

# Thread Steering

## Purpose

Change or stop delegated work deliberately, with the smallest intervention that reaches the goal.

## Use this skill when

- a child needs a follow-up instruction or corrected course while it runs;
- delegated work must be stopped, partially or entirely.

## Do not use this skill when

- the child only needs time; steering cannot speed execution;
- the intent is to read state; that is inspection, not steering.

## Procedure

1. Queue follow-up work with `send_to_thread` using a self-contained prompt; the instruction queues behind the child's current work and its result returns automatically.
2. To cancel only the active prompt, use `interrupt_thread` with the exact `threadId` and `promptId` from `list_threads` or `get_thread`. Interrupting keeps the child, its queued inputs, and its descendants.
3. To close a child and its entire subtree, use `terminate_thread`. Termination cancels active and queued work, closes descendants, keeps history, and cannot be undone.
4. Interruption does not undo effects and does not stop descendants; prefer interrupting a single prompt over terminating a subtree when the child's remaining work is still wanted.
5. After steering, verify the new state with `get_thread` before relying on it.

## Completion

The child's course is corrected or its work is stopped as intended, the narrowest effective control was used, and the resulting state was verified.
