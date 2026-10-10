import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';

import type { Log } from 'bundle/contracts';
import type { Host, ThreadControl, WorkspaceControl } from 'host';
import { type Sandbox, workspacePathKind } from 'sandbox';

import type { Executor, HistoryReader } from '../../contracts/executor.js';
import {
  type CwdRefusal,
  type CwdRepo,
  type CwdResult,
  type EditQueueResult,
  type InputSource,
  isTerminal,
  nameFromPrompt,
  type Thread,
  type ThreadGit,
} from '../../contracts/model.js';
import type { InterruptResult } from '../../contracts/threads.js';
import { cwdRepoHint, threadGit } from '../provisional/git-status.js';
import type { TerminalRegistry } from '../provisional/terminals.js';
import {
  queuedPrompt,
  queuedPrompts,
  resumablePrompt,
} from '../store/queue.js';
import type { ThreadStore } from '../store/types.js';
import type { Bindings } from './bindings.js';
import { physicallyInside } from './cwd.js';
import { delegatedResult } from './prompts.js';
import type { Redactor } from './redactor.js';
import {
  type ProjectRuntime,
  type PromptJob,
  subtreeIds,
  ThreadPersistenceError,
  type ThreadRuntime,
} from './runtime.js';
import { eventJson } from './serialization.js';
import { createSession } from './session.js';
import { pauseForStorage } from './storage-pause.js';
import { guardStorage, storageFull } from './storage-pressure.js';
import type { WorkspacePublisher } from './types.js';

/*
 * Moved from agents/doric (workspace/runner.ts, design 57 §4.10, §4.11). The
 * execution is the executor/v1 port with the runtime's PromptSession, the
 * turn boundary is the executor's checkpoint patch, and the prompt's Host
 * facade is bound to its scope (§4.4) for the tools' runtime contracts.
 */

export interface RunnerContext {
  readonly terminals: TerminalRegistry;
  readonly threads: ThreadStore;
  readonly publisher: WorkspacePublisher;
  readonly log: Log;
  readonly redactor: Redactor;
  readonly bindings: Bindings;
  /** executor/v1 bound to one prompt's scope. */
  readonly executor: (scope: {
    readonly projectId: string;
    readonly threadId: string;
    readonly promptId: string;
  }) => Executor;
  readonly checkStorage?: () => Promise<void>;
  readonly exclusive: <Value>(
    id: string,
    operation: () => Promise<Value>,
  ) => Promise<Value>;
}

/** Owns independent prompt loops. Only queue/state mutations use the project lock. */
export const createThreadRunner = (context: RunnerContext) => {
  const { exclusive, threads: store, publisher } = context;
  const publish = async (
    thread: ThreadRuntime,
    job: PromptJob,
    event: unknown,
  ) => {
    const value = await store.appendEvent(
      thread.thread.id,
      job.id,
      eventJson(event, await context.redactor.current()),
    );
    publisher.event(value);
  };
  const state = async (
    thread: ThreadRuntime,
    value: Thread['state'],
    promptId?: string,
    errorCode?: string,
  ) => {
    const previous = thread.thread.activePromptId;
    const updated = await store.setState(
      thread.thread.id,
      value,
      promptId,
      errorCode ??
        (value === 'ready' && thread.thread.queuePaused
          ? thread.thread.errorCode
          : undefined),
    );
    if (updated !== undefined) {
      thread.thread = updated;
      if (previous !== updated.activePromptId) {
        const event = await store.appendEvent(
          updated.id,
          promptId ?? previous ?? randomUUID(),
          { type: 'queue.updated' },
        );
        publisher.event(event);
        thread.thread = { ...updated, lastSequence: event.sequence };
      }
      publisher.threadUpdated(thread.thread);
    }
  };
  // Caller holds the project's mutation lock.
  const enqueue = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    prompt: string,
    source: InputSource,
  ) => {
    if (project.closing || thread.closing || isTerminal(thread.thread.state)) {
      return { status: 'inactive' as const };
    }
    if (prompt.trim().length === 0)
      throw new TypeError('A non-empty prompt is required.');
    const job: PromptJob = { id: randomUUID(), prompt, source };
    const queued =
      thread.thread.queuePaused === true ||
      thread.storagePending !== undefined ||
      thread.active !== undefined ||
      thread.jobs.length > 0 ||
      project.lease === undefined;
    const values = [
      { type: 'prompt.accepted', text: prompt, source, queued },
      ...(queued ? [{ type: 'prompt.queued' }] : []),
    ];
    const redactions = await context.redactor.current();
    const accepted = await store.appendEvents(
      thread.thread.id,
      job.id,
      values.map((event) => eventJson(event, redactions)),
    );
    for (const event of accepted) publisher.event(event);
    thread.jobs.push(job);
    start(project, thread);
    return { status: 'accepted' as const, promptId: job.id };
  };
  /**
   * Queues one prompt the log already accepted, opening the attempt the host is
   * taking up instead of accepting the input a second time: a resumed prompt is
   * the same turn continuing, so it keeps its own id and its own events, and it
   * is never duplicated while the Thread still holds it.
   */
  // Caller holds the project's mutation lock.
  const resume = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    job: PromptJob,
    attempt: number,
  ): Promise<
    | { readonly status: 'resumed'; readonly thread: Thread }
    | { readonly status: 'inactive' | 'busy' }
  > => {
    if (project.closing || thread.closing || isTerminal(thread.thread.state)) {
      return { status: 'inactive' as const };
    }
    if (
      thread.active?.job.id === job.id ||
      thread.jobs.some(({ id }) => id === job.id)
    ) {
      return { status: 'busy' as const };
    }
    await publish(thread, job, { type: 'prompt.resumed', attempt });
    thread.jobs.push(job);
    // The event moved the Thread's last sequence, so the record this answers with
    // is read back rather than handed out one event behind the log.
    const current = await store.record(thread.thread.id);
    if (current !== undefined) thread.thread = current;
    start(project, thread);
    return { status: 'resumed' as const, thread: thread.thread };
  };
  const notify = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    job: PromptJob,
    status: string,
    text: string,
  ) => {
    if (job.source.kind !== 'parent') return;
    const source = job.source;
    await exclusive(project.project.id, async () => {
      const parent = project.threads.get(source.threadId);
      if (parent === undefined || parent.closing || project.closing) return;
      await enqueue(
        project,
        parent,
        delegatedResult(
          thread.thread.id,
          job.id,
          source.promptId,
          status,
          String(eventJson(text, await context.redactor.current())),
        ),
        {
          kind: 'result',
          threadId: thread.thread.id,
          promptId: job.id,
          requestPromptId: source.promptId,
        },
      );
    });
  };
  const finishJob = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    job: PromptJob,
    status: string,
    text: string,
  ) => {
    await publish(thread, job, {
      type: 'prompt.finished',
      status,
      text,
      source: job.source,
    });
    // Materialize the result on the thread, so reading its state later never has
    // to reconstruct it from the event log. The last finished prompt wins.
    await store.setResult(thread.thread.id, {
      status,
      text,
      promptId: job.id,
      at: new Date().toISOString(),
    });
    if (thread.active?.job.id === job.id) thread.active.reported = true;
    await notify(project, thread, job, status, text);
  };
  const scopeOf = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    job: PromptJob,
  ) => ({
    projectId: project.project.id,
    threadId: thread.thread.id,
    promptId: job.id,
  });
  /**
   * Runs one prompt through executor/v1 with the runtime's PromptSession,
   * while the prompt's Host facade and sandbox are bound to its scope for the
   * tools that reach the runtime contracts (design 57 §4.4, §4.10). The
   * binding is released once the run settled, as the adapter's was.
   */
  const execute = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    active: NonNullable<ThreadRuntime['active']>,
    sandbox: Sandbox,
    host: Host,
  ): Promise<string> => {
    const job = active.job;
    const scope = scopeOf(project, thread, job);
    const executor = context.executor(scope);
    let reader: HistoryReader;
    try {
      reader = await store.history(thread.thread.id);
    } catch (cause) {
      throw new ThreadPersistenceError(cause);
    }
    const session = createSession({
      threadId: thread.thread.id,
      promptId: job.id,
      reader,
      store,
      redactor: context.redactor,
      publish: (event) => publisher.event(event),
    });
    const once = async (signal: AbortSignal): Promise<string> => {
      // A history this executor cannot read fails before any model call.
      if (
        reader.format !== undefined &&
        !(await executor.formats()).includes(reader.format)
      ) {
        context.log.error('Thread history format is unsupported', {
          code: 'history_format_unsupported',
          threadId: thread.thread.id,
        });
        throw new Error('The Thread history format is unsupported.');
      }
      try {
        const result = await executor.run(
          { thread: thread.thread, job, session },
          { signal },
        );
        return result.text;
      } catch (error) {
        // The session's own failure keeps its retry across the dispatcher.
        throw session.failure ?? error;
      }
    };
    const release = context.bindings.attach(scope, { host, sandbox });
    try {
      return context.checkStorage === undefined
        ? await once(active.controller.signal)
        : await guardStorage(
            once,
            active.controller.signal,
            context.checkStorage,
            () => active.controller.abort(),
          );
    } finally {
      release();
    }
  };
  const run = async (project: ProjectRuntime, thread: ThreadRuntime) => {
    while (true) {
      const active = await exclusive(project.project.id, async () => {
        if (
          project.closing ||
          thread.closing ||
          thread.thread.queuePaused ||
          thread.storagePending !== undefined ||
          project.lease === undefined
        )
          return undefined;
        if (thread.jobs.length === 0) return undefined;
        await context.checkStorage?.();
        const job = thread.jobs.shift();
        if (job === undefined) return undefined;
        const active = {
          job,
          controller: new AbortController(),
          finished: false,
        };
        thread.active = active;
        await state(thread, 'running', job.id);
        // The turn's rewind boundary is the history it is about to read: the
        // executor records it once, and an existing boundary wins.
        const patch = await context
          .executor(scopeOf(project, thread, job))
          .checkpoint({
            history: await store.history(thread.thread.id),
            promptId: job.id,
          });
        await store.saveCheckpoint(thread.thread.id, patch);
        await publish(thread, job, { type: 'prompt.started' });
        return active;
      });
      if (active === undefined) return;
      let status = 'completed';
      let text = '';
      let paused = false;
      try {
        const lease = project.lease;

        if (lease === undefined)
          throw new Error('Project sandbox lease is unavailable.');

        const host: Host = {
          threads: coordinate(project, thread, active.job),
          workspace: workspace(project, thread, active.job),
          terminals: {
            run: async (input) => {
              active.controller.signal.throwIfAborted();
              if (project.closing || thread.closing)
                throw new Error('Thread is inactive.');
              // The terminal stream redacts with the list read here.
              await context.redactor.current();
              const started = await context.terminals.start({
                sandbox: lease.sandbox,
                projectId: project.project.id,
                threadId: thread.thread.id,
                origin: 'agent',
                input,
                ...(input.background
                  ? {}
                  : { signal: active.controller.signal }),
              });
              if (!input.background) return started.result;
              void started.result
                .then((result) =>
                  exclusive(project.project.id, async () => {
                    if (project.closing || thread.closing) return;
                    const text = `# Background terminal result\n\nTerminal: ${result.terminalId}\nOriginating prompt: ${active.job.id}\nCommand: ${input.command}\nExit code: ${result.exitCode}\nReason: ${result.reason}\nDuration: ${result.durationMs} ms\n\n## Standard output (last 12000 characters)\n\n${result.stdout.slice(-12000)}\n\n## Standard error (last 12000 characters)\n\n${result.stderr.slice(-12000)}`;
                    await enqueue(
                      project,
                      thread,
                      String(eventJson(text, await context.redactor.current())),
                      {
                        kind: 'terminal',
                        terminalId: result.terminalId,
                        promptId: active.job.id,
                      },
                    );
                  }),
                )
                .catch(async () => {
                  context.log.error('Terminal result delivery failed', {
                    threadId: thread.thread.id,
                  });
                  await exclusive(project.project.id, () =>
                    close(project, [thread], 'terminal_result_failed'),
                  );
                });
              return {
                terminalId: started.terminal.id,
                background: true as const,
              };
            },
          },
        };
        text = await execute(project, thread, active, lease.sandbox, host);
        active.controller.signal.throwIfAborted();
      } catch (error) {
        if (storageFull(error)) throw error;
        if (error instanceof ThreadPersistenceError) throw error;
        const reason = thread.pausing;
        if (reason !== undefined) {
          // A deliberate abort pauses the prompt: it stays unfinished, so the
          // host takes it up again — at the next boot for a stop, when the
          // reader asks for one the reader made — and no result is written.
          paused = true;
          thread.pausing = undefined;
          await publish(thread, active.job, { type: 'prompt.paused', reason });
        } else {
          status = active.controller.signal.aborted ? 'cancelled' : 'failed';
          text =
            status === 'cancelled'
              ? 'The prompt was cancelled.'
              : 'The prompt failed.';
          await publish(thread, active.job, {
            type: status === 'cancelled' ? 'agent.cancelled' : 'agent.failed',
            error,
          });
        }
      }
      active.finished = true;
      if (!paused) await finishJob(project, thread, active.job, status, text);
      await exclusive(project.project.id, async () => {
        thread.active = undefined;
        if (!thread.closing && !project.closing) await state(thread, 'ready');
      });
      await hint(project, thread);
    }
  };
  const start = (project: ProjectRuntime, thread: ThreadRuntime) => {
    if (
      thread.task !== undefined ||
      thread.thread.queuePaused ||
      thread.storagePending !== undefined ||
      thread.closing ||
      project.closing ||
      project.lease === undefined ||
      thread.jobs.length === 0
    )
      return;
    thread.task = run(project, thread)
      .catch(async (error) => {
        if (
          storageFull(error) &&
          ((!thread.closing && !project.closing) ||
            thread.pausing === 'host_stopped')
        ) {
          await exclusive(project.project.id, () =>
            pauseForStorage(context, thread, error),
          );
          return;
        }
        thread.active?.controller.abort();
        // Fail closed on a persistence fault; never run further jobs with stale history.
        context.log.error('Thread persistence failed', {
          threadId: thread.thread.id,
          err: error,
        });
        await exclusive(project.project.id, () =>
          close(project, [thread], 'persistence_failed'),
        );
        if (thread.active !== undefined && !thread.active.reported) {
          await finishJob(
            project,
            thread,
            thread.active.job,
            'failed',
            'Thread persistence failed.',
          ).catch((error) => {
            context.log.error('Prompt failure persistence failed', {
              threadId: thread.thread.id,
              err: error,
            });
          });
        }
      })
      .finally(() => {
        thread.active = undefined;
        thread.task = undefined;
        start(project, thread);
      });
  };
  const create = async (
    project: ProjectRuntime,
    name: string,
    parentThreadId?: string,
  ) => {
    if (project.closing) return { status: 'inactive' as const };
    let inherit:
      | { readonly cwd: string; readonly cwdRepo?: CwdRepo }
      | undefined;
    if (parentThreadId !== undefined) {
      const parent = project.threads.get(parentThreadId);
      if (parent === undefined) return { status: 'invalid_parent' as const };
      if (parent.closing) return { status: 'inactive' as const };
      // A child reads the same sandbox as its parent, so it starts where its
      // parent is right now and carries the hint that directory had.
      inherit = {
        cwd: parent.thread.cwd,
        ...(parent.thread.cwdRepo === undefined
          ? {}
          : { cwdRepo: parent.thread.cwdRepo }),
      };
    }
    const record = await store.create(
      project.project.id,
      name,
      parentThreadId,
      inherit,
    );
    const runtime: ThreadRuntime = {
      thread: record.thread,
      jobs: [],
      closing: false,
    };
    project.threads.set(record.thread.id, runtime);
    if (project.lease !== undefined) await state(runtime, 'ready');
    else publisher.threadUpdated(record.thread);
    return { status: 'created' as const, thread: runtime.thread };
  };
  const interrupt = (
    thread: ThreadRuntime,
    promptId: string,
    reason?: 'reader_stopped',
  ): InterruptResult => {
    if (thread.closing) return 'inactive';
    if (thread.active?.job.id !== promptId || thread.active.finished)
      return 'not_running';
    // A reader's stop pauses the run, so the reader can take it up again; any
    // other caller stops the run outright, exactly as it always did.
    if (reason !== undefined) thread.pausing = reason;
    thread.active.controller.abort();
    return 'interrupted';
  };
  const queueState = async (thread: ThreadRuntime, paused: boolean) => {
    const event = await store.appendEvent(
      thread.thread.id,
      thread.active?.job.id ?? randomUUID(),
      {
        type: paused ? 'queue.paused' : 'queue.resumed',
      },
    );
    thread.thread = (await store.record(thread.thread.id)) ?? thread.thread;
    publisher.event(event);
    publisher.threadUpdated(thread.thread);
  };
  /** Caller holds the scheduler lock. Close the gate before asking work to stop. */
  const pause = async (thread: ThreadRuntime): Promise<InterruptResult> => {
    if (thread.closing || isTerminal(thread.thread.state)) return 'inactive';
    if (thread.thread.queuePaused) return 'interrupted';
    thread.thread = { ...thread.thread, queuePaused: true };
    try {
      await queueState(thread, true);
    } finally {
      if (thread.active !== undefined && !thread.active.finished) {
        thread.pausing = 'reader_stopped';
        thread.active.controller.abort();
      }
    }
    return 'interrupted';
  };
  /** Rebuild the FIFO from durable inputs before reopening dispatch. */
  const resumeQueue = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    promptId?: string,
  ) => {
    if (project.closing || thread.closing || isTerminal(thread.thread.state))
      return { status: 'inactive' as const };
    if (!thread.thread.queuePaused && thread.storagePending === undefined)
      return { status: 'resumed' as const, thread: thread.thread };
    if (thread.active !== undefined) return { status: 'busy' as const };
    try {
      await context.checkStorage?.();
      await thread.storagePending?.();
    } catch (error) {
      if (storageFull(error) || thread.storagePending !== undefined)
        return { status: 'storage_low' as const };
      throw error;
    }
    const progress = (await store.unfinishedPrompts(thread.thread.id)).filter(
      (prompt) => !prompt.superseded,
    );
    const first =
      promptId === undefined
        ? resumablePrompt(progress)
        : progress.find((prompt) => prompt.promptId === promptId);
    if (promptId !== undefined && first === undefined)
      return { status: 'unknown_prompt' as const };
    const queued = queuedPrompts(progress).filter(
      (prompt) => prompt.promptId !== first?.promptId,
    );
    const pending = first === undefined ? queued : [first, ...queued];
    const jobs: PromptJob[] = [];
    for (const prompt of pending) {
      const job = {
        id: prompt.promptId,
        prompt: prompt.text,
        source: prompt.source,
      };
      if (prompt.paused !== undefined)
        await publish(thread, job, {
          type: 'prompt.resumed',
          attempt: prompt.attempts + 1,
          first: prompt === first,
        });
      jobs.push(job);
    }
    thread.jobs.splice(0, thread.jobs.length, ...jobs);
    await queueState(thread, false);
    await state(thread, 'ready');
    start(project, thread);
    return { status: 'resumed' as const, thread: thread.thread };
  };
  /** Caller holds the dispatch lock; edits cannot race the start of execution. */
  const editQueued = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    promptId: string,
    text: string,
    revision: number,
  ): Promise<EditQueueResult> => {
    if (project.closing || thread.closing || isTerminal(thread.thread.state))
      return { status: 'inactive' };
    if (thread.active?.job.id === promptId) return { status: 'not_editable' };
    if (!text.trim() || !Number.isSafeInteger(revision) || revision < 0)
      return { status: 'invalid_prompt' };
    const progress = (await store.unfinishedPrompts(thread.thread.id)).find(
      (entry) => entry.promptId === promptId && !entry.superseded,
    );
    if (progress === undefined) return { status: 'unknown_prompt' };
    const current = queuedPrompt(progress);
    if (!current.editable) return { status: 'not_editable' };
    if (current.revision !== revision) return { status: 'conflict' };
    if (current.text === text) return { status: 'updated', prompt: current };
    const event = await store.appendEvent(
      thread.thread.id,
      promptId,
      eventJson(
        { type: 'prompt.edited', text },
        await context.redactor.current(),
      ),
    );
    const index = thread.jobs.findIndex((job) => job.id === promptId);
    if (index !== -1)
      thread.jobs[index] = { ...thread.jobs[index], prompt: text };
    publisher.event(event);
    return {
      status: 'updated',
      prompt: {
        ...current,
        revision: event.sequence,
        text: (event.event as { text: string }).text,
      },
    };
  };
  /** Caller holds the dispatch lock; an input already running cannot be removed. */
  const removeQueued = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    promptId: string,
  ) => {
    if (project.closing || thread.closing || isTerminal(thread.thread.state))
      return 'inactive' as const;
    if (thread.active?.job.id === promptId) return 'busy' as const;
    const progress = await store.unfinishedPrompts(thread.thread.id);
    const prompt = progress.find(
      (entry) => entry.promptId === promptId && !entry.superseded,
    );
    if (prompt === undefined) {
      const removed = (await store.eventsAfter(thread.thread.id, 0)).some(
        (event) =>
          event.promptId === promptId &&
          event.type === 'prompt.finished' &&
          (event.event as { reason?: string } | null)?.reason ===
            'queue_removed',
      );
      return removed ? ('removed' as const) : ('unknown_prompt' as const);
    }
    const job = { id: promptId, prompt: prompt.text, source: prompt.source };
    await publish(thread, job, {
      type: 'prompt.finished',
      status: 'cancelled',
      text: '',
      source: prompt.source,
      reason: 'queue_removed',
    });
    const index = thread.jobs.findIndex((entry) => entry.id === promptId);
    if (index !== -1) thread.jobs.splice(index, 1);
    await store.setResult(thread.thread.id, {
      promptId,
      status: 'cancelled',
      text: '',
      at: new Date().toISOString(),
    });
    // This path already owns the project lock, so notify the parent directly.
    if (prompt.source.kind === 'parent') {
      const source = prompt.source;
      const parent = project.threads.get(source.threadId);
      if (parent !== undefined && !parent.closing)
        await enqueue(
          project,
          parent,
          delegatedResult(
            thread.thread.id,
            promptId,
            source.promptId,
            'cancelled',
            'Removed from queue.',
          ),
          {
            kind: 'result',
            threadId: thread.thread.id,
            promptId,
            requestPromptId: source.promptId,
          },
        );
    }
    return 'removed' as const;
  };
  // Caller holds the project's mutation lock.
  const rewind = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    promptId: string,
    prompt: string,
  ) => {
    if (project.closing || thread.closing || isTerminal(thread.thread.state))
      return { status: 'inactive' as const };
    // Queued or active work would otherwise run on truncated history.
    if (thread.active !== undefined || thread.jobs.length > 0)
      return { status: 'busy' as const };
    const marker = await store.rewind(thread.thread.id, promptId);
    if (marker === undefined) return { status: 'unknown_prompt' as const };
    publisher.event(marker);
    return enqueue(project, thread, prompt, { kind: 'user' });
  };
  const descendants = (project: ProjectRuntime, rootId: string) => {
    const threads = [...project.threads.values()].map(({ thread }) => thread);
    const ids = subtreeIds(threads, rootId);
    return [...ids].flatMap((id) => {
      const thread = project.threads.get(id);
      return thread === undefined ? [] : [thread];
    });
  };
  // Mark every descendant closed before any await: no new branch can escape.
  const close = async (
    project: ProjectRuntime,
    values: readonly ThreadRuntime[],
    failure?: string,
  ) => {
    const targets = values.filter((thread) => !thread.closing);
    for (const thread of targets) {
      thread.closing = true;
      thread.active?.controller.abort();
    }
    await context.terminals
      .close(targets.map(({ thread }) => thread.id))
      .catch(() => {
        context.log.error('Terminal cleanup failed', {
          projectId: project.project.id,
        });
      });
    for (const thread of targets) {
      thread.thread = { ...thread.thread, state: 'cancelling' };
      await state(thread, 'cancelling').catch(() => {
        context.log.error('Thread cancellation persistence failed', {
          threadId: thread.thread.id,
        });
      });
      const pending = thread.jobs.splice(0);
      const task = thread.task;
      thread.ending = Promise.resolve()
        .then(async () => {
          for (const job of pending) {
            try {
              await publish(thread, job, {
                type:
                  failure === undefined ? 'agent.cancelled' : 'agent.failed',
              });
              await finishJob(
                project,
                thread,
                job,
                failure === undefined ? 'cancelled' : 'failed',
                failure === undefined
                  ? 'The prompt was cancelled.'
                  : 'The project is unavailable.',
              );
            } catch {
              context.log.error('Queued cancellation persistence failed', {
                threadId: thread.thread.id,
              });
            }
          }
          await task;
          await exclusive(project.project.id, () =>
            state(
              thread,
              failure === undefined ? 'cancelled' : 'failed',
              undefined,
              failure,
            ),
          );
        })
        .catch(() => {
          context.log.error('Thread termination persistence failed', {
            threadId: thread.thread.id,
          });
        });
    }
  };
  /**
   * Suspends every live Thread of a host that is stopping, without terminating
   * it. The run that is executing is *paused* — left unfinished, so the next boot
   * takes it up again — and the queue the Thread was holding stays accepted and
   * unfinished for the same reason. Each Thread is written back as `ready`.
   * Explicit termination stays `close`, which is terminal.
   */
  // Caller holds the project's mutation lock.
  const suspend = (
    project: ProjectRuntime,
    values: readonly ThreadRuntime[],
  ) => {
    const targets = values.filter(
      (thread) => !thread.closing && !isTerminal(thread.thread.state),
    );
    for (const thread of targets) {
      thread.closing = true;
      if (thread.active !== undefined && !thread.active.finished) {
        thread.pausing ??= 'host_stopped';
        thread.active.controller.abort();
      }
    }
    for (const thread of targets) {
      const task = thread.task;
      thread.ending = Promise.resolve()
        .then(async () => {
          // The aborted run settles here, writing its own pause before the
          // Thread is written back as ready.
          await context.terminals.close([thread.thread.id]).catch(() => {
            context.log.error('Terminal cleanup failed', {
              threadId: thread.thread.id,
            });
          });
          await task;
          await exclusive(project.project.id, () => state(thread, 'ready'));
        })
        .catch(() => {
          context.log.error('Thread suspension persistence failed', {
            threadId: thread.thread.id,
          });
        });
    }
  };
  /**
   * Whether one prompt is still the prompt its Thread is running. Every
   * prompt-scoped capability checks it, so neither the delegation tools nor the
   * working directory outlive the prompt that reached them.
   */
  const active = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    job: PromptJob,
  ) => {
    if (
      project.closing ||
      thread.closing ||
      thread.active?.job.id !== job.id ||
      thread.active.finished ||
      thread.active.controller.signal.aborted
    )
      throw new Error('Thread control is no longer active.');
  };
  /**
   * `cd` semantics for one working directory: an absolute path stands alone and
   * a relative one resolves against the current directory, so the `cwd` tool and
   * `PATCH /threads/:id` agree on every path either of them is given. The result
   * is normalized, so `.` and `..` segments can neither leave the sandbox root
   * nor leave a trailing slash in the stored value; an escape is `undefined`,
   * which the caller reports as the `outside` refusal.
   */
  const resolveCwd = (
    root: string,
    current: string,
    path: string,
  ): string | undefined => {
    const resolved = normalize(isAbsolute(path) ? path : join(current, path));
    const trimmed =
      resolved.length > 1 ? resolved.replace(/\/+$/u, '') : resolved;
    const inside =
      root === '/'
        ? trimmed.startsWith('/')
        : trimmed === root || trimmed.startsWith(`${root}/`);

    return inside ? trimmed : undefined;
  };
  const refused = (change: CwdRefusal['status']): CwdResult => ({
    status: 'refused',
    change: { status: change },
  });
  /**
   * Moves one Thread's working directory: the single rule the agent's `cwd` tool
   * and the HTTP route both call. It refuses anything outside the sandbox or that
   * is no directory, then writes the directory and its repository hint together,
   * under the project lock, so nothing observes the record between the probe and
   * the write.
   */
  const setCwd = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    path: string,
  ): Promise<CwdResult> => {
    const lease = project.lease;
    if (project.closing || lease === undefined)
      return Promise.resolve({ status: 'inactive' as const });
    const sandbox = lease.sandbox;

    return exclusive(project.project.id, async () => {
      if (project.closing || thread.closing || project.lease !== lease)
        return { status: 'inactive' as const };
      const target = resolveCwd(sandbox.root, thread.thread.cwd, path);
      if (target === undefined) return refused('outside');
      // The path is already inside the root, so what is left to ask is whether
      // it exists and whether it is a directory.
      const kind = await workspacePathKind(sandbox, target);
      if (kind === 'missing') return refused('missing');
      if (kind !== 'directory') return refused('not-directory');
      // A path that reads as inside the root can still resolve outside it
      // through a symbolic link, which only the sandbox can see; that is the
      // same refusal as a path that leaves the root outright.
      if (!(await physicallyInside(sandbox, sandbox.root, target)))
        return refused('outside');
      const cwdRepo = await cwdRepoHint(sandbox, target);
      const updated = await store.setCwd(thread.thread.id, target, cwdRepo);
      if (updated === undefined) return { status: 'missing' as const };
      thread.thread = updated;
      publisher.threadUpdated(updated);
      return { status: 'updated' as const, thread: updated };
    });
  };
  /**
   * Re-reads the working directory's repository hint after a job settles, when
   * the job may have created, removed, or re-origined a repository. The probe
   * runs outside the project lock and the write re-checks the directory it
   * probed, so a hint can never describe a directory the Thread has left; a
   * probe that fails keeps the hint the record already had, because a hint is an
   * optimization and no prompt should fail over one.
   */
  const hint = async (project: ProjectRuntime, thread: ThreadRuntime) => {
    const sandbox = project.lease?.sandbox;
    if (sandbox === undefined || thread.closing) return;
    const cwd = thread.thread.cwd;
    let cwdRepo: CwdRepo | undefined;
    try {
      cwdRepo = await cwdRepoHint(sandbox, cwd);
    } catch (error) {
      context.log.debug('Thread Git hint probe failed', {
        threadId: thread.thread.id,
        err: error,
      });
      return;
    }
    await exclusive(project.project.id, async () => {
      if (thread.closing || thread.thread.cwd !== cwd) return;
      if (thread.thread.cwdRepo === cwdRepo) return;
      const updated = await store.setCwd(thread.thread.id, cwd, cwdRepo);
      if (updated === undefined) return;
      thread.thread = updated;
      publisher.threadUpdated(updated);
    });
  };
  /**
   * The Git summary of one Thread's working directory. The read probes the
   * sandbox every time: a working directory changes under the agent while one of
   * its prompts runs, and a summary served from a cache would be the state of
   * the last settle rather than the state the reader is watching. Reading it
   * also refreshes the record's hint, so opening a changes view is what catches
   * the Thread record up with the sandbox.
   */
  const git = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    sandbox: Sandbox,
  ): Promise<ThreadGit> => {
    const summary = await threadGit(sandbox, thread.thread.cwd);
    await hint(project, thread);
    return summary;
  };
  /**
   * The prompt's own working directory, bound to the Thread that owns the prompt
   * rather than to a snapshot of it: a move is the very next `cwd()` reads, in
   * the same prompt.
   */
  const workspace = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    job: PromptJob,
  ): WorkspaceControl => ({
    cwd: () => thread.thread.cwd,
    setCwd: async (path) => {
      active(project, thread, job);
      const result = await setCwd(project, thread, path);
      if (result.status === 'updated')
        return { status: 'set', cwd: result.thread.cwd };
      if (result.status === 'refused') return result.change;
      throw new Error('Thread control is no longer active.');
    },
  });
  const coordinate = (
    project: ProjectRuntime,
    parent: ThreadRuntime,
    job: PromptJob,
  ): ThreadControl => {
    const allowed = () => active(project, parent, job);
    const child = async (id: string) => {
      allowed();
      const record = await store.record(id);
      if (
        record?.parentThreadId !== parent.thread.id ||
        record.projectId !== project.project.id
      )
        throw new Error('Thread is not a direct child.');
      return record;
    };
    const source = {
      kind: 'parent' as const,
      threadId: parent.thread.id,
      promptId: job.id,
    };
    return {
      spawn: (prompt) =>
        exclusive(project.project.id, async () => {
          allowed();
          if (prompt.trim().length === 0)
            throw new TypeError('A non-empty prompt is required.');
          const created = await create(
            project,
            nameFromPrompt(prompt),
            parent.thread.id,
          );
          if (created.status !== 'created')
            throw new Error('Thread cannot be created.');
          const thread = project.threads.get(created.thread.id);

          if (thread === undefined)
            throw new Error('Thread cannot be created.');

          const accepted = await enqueue(project, thread, prompt, source);
          if (accepted.status !== 'accepted')
            throw new Error('Thread cannot accept a task.');
          return { threadId: created.thread.id, promptId: accepted.promptId };
        }),
      list: (limit, cursor) =>
        exclusive(project.project.id, () => {
          allowed();
          return store.list(
            project.project.id,
            limit,
            cursor,
            parent.thread.id,
          );
        }),
      get: (id) =>
        exclusive(project.project.id, async () => {
          const record = await child(id);
          return {
            thread: record,
            ...(record.result === undefined ? {} : { result: record.result }),
          };
        }),
      events: (id, afterSequence, limit) =>
        exclusive(project.project.id, async () => {
          await child(id);
          return store.eventsAfterPage(id, afterSequence, limit);
        }),
      send: (id, prompt) =>
        exclusive(project.project.id, async () => {
          await child(id);
          const target = project.threads.get(id);
          return target === undefined
            ? { status: 'inactive' as const }
            : enqueue(project, target, prompt, source);
        }),
      interrupt: (id, promptId) =>
        exclusive(project.project.id, async () => {
          await child(id);
          const target = project.threads.get(id);
          return target === undefined
            ? 'inactive'
            : interrupt(target, promptId);
        }),
      terminate: (id) =>
        exclusive(project.project.id, async () => {
          const value = await child(id);
          await close(project, descendants(project, id));
          return project.threads.get(id)?.thread ?? value;
        }),
    };
  };
  /**
   * Resets one Thread's working directory to the workspace root after a reacquired
   * sandbox no longer holds it, clearing the repository hint with it. The caller
   * holds the project lock, because a reset belongs to the acquisition that
   * proved the directory gone.
   */
  const resetCwd = async (project: ProjectRuntime, thread: ThreadRuntime) => {
    const root = project.lease?.sandbox.root;
    if (root === undefined) return;
    const updated = await store.setCwd(thread.thread.id, root, undefined);
    if (updated === undefined) return;
    thread.thread = updated;
    publisher.threadUpdated(updated);
  };
  return {
    start,
    enqueue,
    resume,
    create,
    interrupt,
    pause,
    resumeQueue,
    removeQueued,
    editQueued,
    rewind,
    descendants,
    close,
    suspend,
    state,
    setCwd,
    resetCwd,
    git,
  };
};
