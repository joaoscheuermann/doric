import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';

import type { Log } from 'bundle/contracts';
import { type Sandbox, workspacePathKind } from 'sandbox';

import type {
  Executor,
  ExecutorThread,
  HistoryReader,
} from '../../contracts/executor.js';
import type { CwdChanged, PromptStarted } from '../../contracts/hooks.js';
import {
  type CompactResult,
  type CwdRefusal,
  type CwdRepo,
  type CwdResult,
  type EditQueueResult,
  type InputSource,
  isTerminal,
  nameFromPrompt,
  type SteerResult,
  type Thread,
  type ThreadGit,
  type ThreadOrigin,
} from '../../contracts/model.js';
import type { InterruptResult, SpawnOptions } from '../../contracts/threads.js';
import type {
  Host,
  ThreadControl,
  WorkspaceControl,
} from '../../contracts/tool-host/index.js';
import {
  cwdRepoHint,
  HintProbeIncompleteError,
  threadGit,
} from '../provisional/git-status.js';
import type { AttachmentStore } from '../store/attachments.js';
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

/**
 * The Thread as `executor.run` / `executor.compact` receive it: its agent with
 * `instructions`, or no agent when none were found, so the executor runs it as
 * the default agent instead of failing validation. Pure; `thread` is not
 * modified.
 */
const executorThread = (
  { agent, ...thread }: Thread,
  instructions: string | undefined,
): ExecutorThread =>
  agent === undefined || instructions === undefined
    ? thread
    : { ...thread, agent: { ...agent, instructions } };

/*
 * Moved from agents/doric (workspace/runner.ts, design 57 §4.10, §4.11). The
 * execution is the executor/v1 port with the runtime's PromptSession, the
 * turn boundary is the executor's checkpoint patch, and the prompt's Host
 * facade is bound to its scope (§4.4) for the tools' runtime contracts.
 */

export interface RunnerContext {
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
  /** The compaction policy the configuration in force names. */
  readonly compactionPolicy: () => Promise<{
    readonly tailMinMessages: number;
    readonly summaryMaxChars: number;
  }>;
  readonly checkStorage?: () => Promise<void>;
  /** The images each Project holds, read back for the prompts it runs. */
  readonly attachments?: AttachmentStore;
  /**
   * runtime.hooks/v1 onThreadsClosingHook, awaited where the terminals of
   * closing Threads close: the `terminal` bundle owns the sessions (stage 10)
   * and closes them in its handler. It resolves even when a handler fails.
   */
  readonly threadsClosing?: (input: {
    readonly projectId: string;
    readonly threadIds: readonly string[];
  }) => Promise<void>;
  /**
   * runtime.hooks/v1 onPromptStartedHook, awaited after `prompt.started` and
   * outside the project lock, before the executor runs the prompt.
   */
  readonly promptStarted?: (input: PromptStarted) => Promise<void>;
  /**
   * runtime.hooks/v1 onThreadCwdChangedHook, awaited outside the project lock
   * once a Thread's working directory or repository hint changed.
   */
  readonly cwdChanged?: (input: CwdChanged) => Promise<void>;
  readonly exclusive: <Value>(
    id: string,
    operation: () => Promise<Value>,
  ) => Promise<Value>;
}

/** Owns independent prompt loops. Only queue/state mutations use the project lock. */
/** How long termination waits for an aborted run to record its end. */
const settleBoundMs = 1000;

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
      await deliver(
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
    reason?: 'interrupted',
  ) => {
    await publish(thread, job, {
      type: 'prompt.finished',
      status,
      text,
      source: job.source,
      ...(reason === undefined ? {} : { reason }),
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
  /**
   * Logs a background terminal result that could not be delivered and closes
   * its Thread, as the runner always did (runtime.threads/v1 1.2.0).
   */
  const failTerminalResult = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
  ) => {
    context.log.error('Terminal result delivery failed', {
      threadId: thread.thread.id,
    });
    await exclusive(project.project.id, () =>
      close(project, [thread], 'terminal_result_failed'),
    );
  };
  /**
   * Enqueues a background terminal's result as a terminal-sourced prompt,
   * under the Project lock, unless the Project or the Thread is closing; a
   * failed enqueue is a failed delivery.
   */
  const terminalResult = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    input: {
      readonly terminalId: string;
      readonly promptId: string;
      readonly text: string;
    },
  ): Promise<void> =>
    exclusive(project.project.id, async () => {
      if (project.closing || thread.closing) return;
      await deliver(
        project,
        thread,
        String(eventJson(input.text, await context.redactor.current())),
        {
          kind: 'terminal',
          terminalId: input.terminalId,
          promptId: input.promptId,
        },
      );
    }).catch(() => failTerminalResult(project, thread));
  /** runtime.hooks/v1 onThreadsClosingHook, awaited; it never fails a close. */
  const threadsClosing = async (projectId: string, threadIds: string[]) => {
    if (threadIds.length === 0) return;
    await context.threadsClosing?.({ projectId, threadIds });
  };
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
    let instructions: string | undefined;
    try {
      reader = await store.history(thread.thread.id);
      if (thread.thread.agent !== undefined)
        instructions = (await store.find(thread.thread.id))?.instructions;
    } catch (cause) {
      throw new ThreadPersistenceError(cause);
    }
    const attachments = context.attachments;
    const session = createSession({
      threadId: thread.thread.id,
      promptId: job.id,
      reader,
      store,
      redactor: context.redactor,
      publish: (event) => publisher.event(event),
      ...(attachments === undefined
        ? {}
        : {
            attachment: (id: string) =>
              attachments.read(thread.thread.projectId, id),
          }),
      steering: {
        take: () => {
          const steers = active.steers.splice(0);
          active.taken.push(...steers);
          return steers;
        },
        applied: () => active.taken.shift(),
      },
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
          {
            thread: executorThread(thread.thread, instructions),
            job,
            session,
          },
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
  /**
   * Whether a failed execution was only a steer aborting the current step, so
   * the prompt continues. A stop, a pause, a close or a persistence fault that
   * met the same abort still ends the run.
   */
  const redirecting = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    active: NonNullable<ThreadRuntime['active']>,
    error: unknown,
  ) =>
    active.redirect === true &&
    !project.closing &&
    !thread.closing &&
    !thread.interrupting &&
    thread.pausing === undefined &&
    !storageFull(error) &&
    !(error instanceof ThreadPersistenceError);
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
        let settle!: () => void;
        const active: NonNullable<ThreadRuntime['active']> & {
          readonly settle: () => void;
        } = {
          job,
          controller: new AbortController(),
          finished: false,
          settled: new Promise<void>((resolve) => {
            settle = resolve;
          }),
          settle: () => settle(),
          steers: [],
          taken: [],
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
      // Outside the lock: a handler may instruct this very prompt, and its
      // instruction is waiting when the executor reads its steering first.
      await context.promptStarted?.({
        projectId: project.project.id,
        threadId: thread.thread.id,
        promptId: active.job.id,
        source: active.job.source,
        cwd: thread.thread.cwd,
        ...(thread.thread.cwdRepo === undefined
          ? {}
          : { cwdRepo: thread.thread.cwdRepo }),
      });
      let status = 'completed';
      let text = '';
      let paused = false;
      let interrupted = false;
      /** Steering the run never took in; it returns to the front of the queue. */
      let returned: readonly PromptJob[] = [];
      try {
        try {
          const lease = project.lease;

          if (lease === undefined)
            throw new Error('Project sandbox lease is unavailable.');

          const host: Host = {
            threads: coordinate(project, thread, active.job),
            workspace: workspace(project, thread, active.job),
          };
          while (true) {
            try {
              text = await execute(
                project,
                thread,
                active,
                lease.sandbox,
                host,
              );
              active.controller.signal.throwIfAborted();
              break;
            } catch (error) {
              if (!redirecting(project, thread, active, error)) throw error;
              // A steer aborted only the current step: the prompt continues
              // from the history it wrote, and takes the steer in first.
              active.redirect = false;
              active.controller = new AbortController();
            }
          }
        } catch (error) {
          if (storageFull(error)) throw error;
          if (error instanceof ThreadPersistenceError) throw error;
          const reason = thread.pausing;
          if (reason === undefined && thread.interrupting) {
            // The reader's stop ends the turn: the history it wrote stays, and
            // the prompt is finished rather than left to resume.
            interrupted = true;
            status = 'cancelled';
            text = 'The prompt was interrupted.';
            await publish(thread, active.job, {
              type: 'agent.cancelled',
              error,
            });
          } else if (reason !== undefined) {
            // A deliberate abort pauses the prompt: it stays unfinished, so the
            // host takes it up again — at the next boot for a stop, when the
            // reader asks for one the reader made — and no result is written.
            paused = true;
            thread.pausing = undefined;
            await publish(thread, active.job, {
              type: 'prompt.paused',
              reason,
            });
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
      } finally {
        thread.interrupting = undefined;
        returned = [...active.taken.splice(0), ...active.steers.splice(0)];
        thread.jobs.unshift(...returned);
        active.settle();
      }
      active.finished = true;
      if (!paused) {
        // A terminated Thread leaves its prompt before the prompt finishes.
        await thread.leaving;
        await finishJob(
          project,
          thread,
          active.job,
          status,
          text,
          interrupted ? 'interrupted' : undefined,
        );
      }
      await exclusive(project.project.id, async () => {
        for (const job of returned) {
          if (thread.jobs.includes(job))
            await publish(thread, job, { type: 'prompt.queued', first: true });
        }
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
    origin?: ThreadOrigin,
    options?: SpawnOptions,
  ) => {
    if (project.closing) return { status: 'inactive' as const };
    let inherit:
      | { readonly cwd: string; readonly cwdRepo?: CwdRepo }
      | undefined;
    if (parentThreadId !== undefined) {
      const parent = project.threads.get(parentThreadId);
      if (parent === undefined) return { status: 'invalid_parent' as const };
      if (parent.closing) return { status: 'inactive' as const };
      // The reader branches a main Thread into a sub-thread, and only an agent
      // nests deeper: it spawns a sub-agent under whatever Thread it is working
      // in. So a Thread the reader opens hangs off the root of its tree.
      if (origin !== 'agent' && parent.thread.parentThreadId !== undefined)
        return { status: 'invalid_parent' as const };
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
      origin,
      options,
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
        thread.interrupting = true;
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
        await deliver(
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
  /**
   * Sends one input into the prompt the Thread is running — `promptId`'s, when
   * one is named. The executor takes it in at its next safe point — after the
   * tool batch in flight, or before the final answer would end the turn — and
   * `interrupt` also aborts the current step, so the prompt continues with the
   * steer at once. Input for a prompt that is no longer running, or for a
   * Thread that is stopping or paused, is queued instead; a steer the run never
   * takes in returns to the front of the queue when the run ends.
   */
  // Caller holds the project's mutation lock.
  const steerInto = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    prompt: string,
    source: InputSource,
    options: { readonly promptId?: string; readonly interrupt?: boolean } = {},
  ): Promise<SteerResult> => {
    if (project.closing || thread.closing || isTerminal(thread.thread.state)) {
      return { status: 'inactive' };
    }
    if (prompt.trim().length === 0)
      throw new TypeError('A non-empty prompt is required.');
    const active = thread.active;
    if (
      active === undefined ||
      active.finished ||
      (options.promptId !== undefined && active.job.id !== options.promptId) ||
      thread.thread.queuePaused === true ||
      thread.interrupting === true ||
      thread.pausing !== undefined ||
      thread.storagePending !== undefined
    ) {
      const queued = await enqueue(project, thread, prompt, source);
      return queued.status === 'accepted'
        ? { status: 'queued', promptId: queued.promptId }
        : queued;
    }
    const job: PromptJob = { id: randomUUID(), prompt, source };
    const accepted = await store.appendEvents(thread.thread.id, job.id, [
      eventJson(
        {
          type: 'prompt.accepted',
          text: prompt,
          source,
          queued: true,
          steer: active.job.id,
        },
        await context.redactor.current(),
      ),
    ]);
    for (const event of accepted) publisher.event(event);
    if (thread.active !== active || active.finished) {
      // The run ended while the steer was accepted: it waits at the front of
      // the queue, as a steer the run never took in does.
      thread.jobs.unshift(job);
      await publish(thread, job, { type: 'prompt.queued', first: true });
      start(project, thread);
      return { status: 'queued', promptId: job.id };
    }
    active.steers.push(job);
    if (options.interrupt === true && !active.controller.signal.aborted) {
      active.redirect = true;
      active.controller.abort();
    }
    return { status: 'steered', promptId: job.id };
  };
  /** The reader's steer of the prompt the reader saw running. */
  // Caller holds the project's mutation lock.
  const steer = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    prompt: string,
    options: { readonly promptId: string; readonly interrupt?: boolean },
  ): Promise<SteerResult> =>
    steerInto(project, thread, prompt, { kind: 'user' }, options);
  /**
   * Delivers a child's result or a background terminal's output to its
   * Thread: into the prompt it is running, which reads it at its next safe
   * point, or into the queue when nothing runs.
   */
  /** A bundle's instruction to its Thread (`runtime.threads/v1.instruct`). */
  // Caller holds the project's mutation lock.
  const instruct = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    prompt: string,
    source: Extract<InputSource, { readonly kind: 'bundle' }>,
    options: { readonly promptId?: string; readonly interrupt?: boolean },
  ): Promise<SteerResult> =>
    steerInto(project, thread, prompt, source, options);
  // Caller holds the project's mutation lock.
  const deliver = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    prompt: string,
    source: Exclude<InputSource, { readonly kind: 'user' }>,
  ): Promise<SteerResult> => steerInto(project, thread, prompt, source);
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
  /**
   * The on-demand compaction of an idle Thread (the executor's `compact`,
   * under the same conditions a rewind runs under). It records its own
   * bracket events through a compaction session: a promptId of its own, no
   * prompt job, no sandbox binding. The executor answers refusals and
   * failures in-band, so they are results here too; a persistence failure
   * keeps the session's retry, like a run's does.
   */
  const compact = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
  ): Promise<CompactResult> => {
    if (project.closing || thread.closing || isTerminal(thread.thread.state))
      return { status: 'inactive' as const };
    // A rewrite the run is reading would tear mid-conversation; the queue
    // must drain first, exactly like a rewind's truncation.
    if (thread.active !== undefined || thread.jobs.length > 0)
      return { status: 'busy' as const };
    const scope = {
      projectId: project.project.id,
      threadId: thread.thread.id,
      promptId: randomUUID(),
    };
    let reader: HistoryReader;
    let instructions: string | undefined;
    try {
      reader = await store.history(thread.thread.id);
      if (thread.thread.agent !== undefined)
        instructions = (await store.find(thread.thread.id))?.instructions;
    } catch (cause) {
      throw new ThreadPersistenceError(cause);
    }
    const executor = context.executor(scope);
    // A history this executor cannot read fails before any model call.
    if (
      reader.format !== undefined &&
      !(await executor.formats()).includes(reader.format)
    )
      return { status: 'not_supported' as const };
    const session = createSession({
      threadId: thread.thread.id,
      promptId: scope.promptId,
      reader,
      store,
      redactor: context.redactor,
      publish: (event) => publisher.event(event),
    });
    try {
      const result = await executor.compact(
        {
          thread: executorThread(thread.thread, instructions),
          session,
          policy: await context.compactionPolicy(),
        },
        { signal: new AbortController().signal },
      );
      return result.status === 'compacted'
        ? {
            status: 'compacted' as const,
            condensedMessages: result.condensedMessages,
            retainedMessages: result.retainedMessages,
            tokensFreed: result.tokensFreed,
          }
        : result.status === 'refused'
          ? { status: 'refused' as const, reason: result.reason }
          : { status: 'failed' as const, code: result.code };
    } catch (error) {
      // The session's own failure keeps its retry across the dispatcher.
      throw session.failure ?? error;
    }
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
    const left = new Map<ThreadRuntime, () => void>();
    for (const thread of targets) {
      thread.closing = true;
      thread.leaving = new Promise<void>((resolve) => {
        left.set(thread, resolve);
      });
      thread.active?.controller.abort();
    }
    // The aborted runs record their own cancellation before the Thread leaves
    // its prompt, whatever the abort's latency to the executor (bounded, so a
    // run that ignores its abort cannot hold the project).
    const settled = targets.flatMap(({ active }) =>
      active?.settled === undefined || active.finished ? [] : [active.settled],
    );
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.all([
      threadsClosing(
        project.project.id,
        targets.map(({ thread }) => thread.id),
      ),
      settled.length === 0
        ? undefined
        : Promise.race([
            Promise.all(settled),
            new Promise((resolve) => {
              bound = setTimeout(resolve, settleBoundMs);
            }),
          ]).finally(() => clearTimeout(bound)),
    ]);
    for (const thread of targets) {
      thread.thread = { ...thread.thread, state: 'cancelling' };
      await state(thread, 'cancelling').catch(() => {
        context.log.error('Thread cancellation persistence failed', {
          threadId: thread.thread.id,
        });
      });
      left.get(thread)?.();
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
          await threadsClosing(project.project.id, [thread.thread.id]);
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
   * The `onThreadCwdChangedHook` input for a Thread whose record moved from
   * `previous`, or undefined when neither its directory nor its hint changed.
   * It names the prompt the Thread runs now, if any.
   */
  const cwdChange = (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    previous: Pick<Thread, 'cwd' | 'cwdRepo'>,
  ): CwdChanged | undefined => {
    const { cwd, cwdRepo } = thread.thread;
    if (cwd === previous.cwd && cwdRepo === previous.cwdRepo) return undefined;
    const active = thread.active;
    return {
      projectId: project.project.id,
      threadId: thread.thread.id,
      ...(active === undefined || active.finished
        ? {}
        : { promptId: active.job.id }),
      cwd,
      ...(cwdRepo === undefined ? {} : { cwdRepo }),
      previous: {
        cwd: previous.cwd,
        ...(previous.cwdRepo === undefined
          ? {}
          : { cwdRepo: previous.cwdRepo }),
      },
    };
  };
  /** Fires `onThreadCwdChangedHook` once the record moved; never inside the lock. */
  const cwdChanged = async (change: CwdChanged | undefined) => {
    if (change !== undefined) await context.cwdChanged?.(change);
  };
  /**
   * Moves one Thread's working directory: the single rule the agent's `cwd` tool
   * and the HTTP route both call. It refuses anything outside the sandbox or that
   * is no directory, then writes the directory and its repository hint together,
   * under the project lock, so nothing observes the record between the probe and
   * the write.
   */
  const setCwd = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    path: string,
  ): Promise<CwdResult> => {
    const lease = project.lease;
    if (project.closing || lease === undefined)
      return { status: 'inactive' as const };
    const sandbox = lease.sandbox;
    const previous = { cwd: thread.thread.cwd, cwdRepo: thread.thread.cwdRepo };

    const result = await exclusive(project.project.id, async () => {
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
      // A probe that did not finish stores no hint, as a non-zero exit did
      // before; an exec that throws still rejects the move.
      const cwdRepo = await cwdRepoHint(sandbox, target).catch(
        (error: unknown) => {
          if (error instanceof HintProbeIncompleteError) return undefined;
          throw error;
        },
      );
      const updated = await store.setCwd(thread.thread.id, target, cwdRepo);
      if (updated === undefined) return { status: 'missing' as const };
      thread.thread = updated;
      publisher.threadUpdated(updated);
      return { status: 'updated' as const, thread: updated };
    });
    // Awaited before the move answers the `cwd` tool, so an instruction a
    // handler gives the running prompt is read after this tool batch.
    if (result.status === 'updated')
      await cwdChanged(cwdChange(project, thread, previous));
    return result;
  };
  /**
   * Re-reads the working directory's repository hint after a job settles, on a
   * Git read, and on `location()`, when the directory may have gained, lost or
   * re-origined a repository. The probe runs outside the project lock and the
   * write re-checks the directory it probed, so a hint can never describe a
   * directory the Thread has left; a probe that fails keeps the hint the record
   * already had, because a hint is an optimization and no prompt should fail
   * over one.
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
    const change = await exclusive(project.project.id, async () => {
      if (thread.closing || thread.thread.cwd !== cwd) return undefined;
      if (thread.thread.cwdRepo === cwdRepo) return undefined;
      const previous = { cwd, cwdRepo: thread.thread.cwdRepo };
      const updated = await store.setCwd(thread.thread.id, cwd, cwdRepo);
      if (updated === undefined) return undefined;
      thread.thread = updated;
      publisher.threadUpdated(updated);
      return cwdChange(project, thread, previous);
    });
    await cwdChanged(change);
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
    location: async () => {
      active(project, thread, job);
      await hint(project, thread);
      const { cwd, cwdRepo } = thread.thread;
      return { cwd, ...(cwdRepo === undefined ? {} : { repo: cwdRepo }) };
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
      spawn: (prompt, title, options) =>
        exclusive(project.project.id, async () => {
          allowed();
          if (prompt.trim().length === 0)
            throw new TypeError('A non-empty prompt is required.');
          if (title !== undefined && title.trim().length === 0)
            throw new TypeError('A non-empty title is required.');
          // An agent is the child's own; a model and an effort fall back to
          // the parent's.
          const created = await create(
            project,
            nameFromPrompt(title ?? prompt),
            parent.thread.id,
            'agent',
            {
              ...options,
              model: options?.model ?? parent.thread.model,
              effort: options?.effort ?? parent.thread.effort,
            },
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
      restart: (id, prompt) => {
        const settled = async () => {
          const live = project.threads.get(id);
          // Outside the lock: `ending`'s last step takes the project lock itself,
          // so awaiting it under the lock would deadlock (mutation queue is not
          // re-entrant).
          if (live?.ending !== undefined) await live.ending;
        };
        return (async () => {
          // A closed Project makes every control inactive, before the prompt's
          // own liveness: termination ends the calling prompt too.
          if (project.closing) return { status: 'inactive' as const };
          allowed();
          if (prompt !== undefined && prompt.trim().length === 0)
            throw new TypeError('A non-empty prompt is required.');
          await settled();
          return exclusive(project.project.id, async () => {
            allowed();
            const record = await child(id); // direct-child guard, unchanged
            if (record.state === 'cancelled')
              return { status: 'terminated' as const };
            if (record.state === 'cancelling')
              return { status: 'inactive' as const };
            if (record.state !== 'failed')
              return { status: 'not_failed' as const };
            if (project.closing) return { status: 'inactive' as const };
            const text = prompt ?? (await store.lastPrompt(id))?.text;
            if (text === undefined || text.trim().length === 0)
              return { status: 'no_prompt' as const };
            const reopened = await store.reopen(id);
            if (reopened === undefined) return { status: 'missing' as const };
            if (reopened.state !== 'ready')
              return { status: 'not_failed' as const };
            const target = project.threads.get(id);
            if (target === undefined) return { status: 'inactive' as const };
            target.closing = false;
            target.ending = undefined;
            target.leaving = undefined;
            target.thread = reopened;
            publisher.threadUpdated(reopened);
            return enqueue(project, target, text, source);
          });
        })();
      },
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
    const previous = { cwd: thread.thread.cwd, cwdRepo: thread.thread.cwdRepo };
    const updated = await store.setCwd(thread.thread.id, root, undefined);
    if (updated === undefined) return;
    thread.thread = updated;
    publisher.threadUpdated(updated);
    // The caller holds the project lock, which a handler's own calls need:
    // the hook is fired here without waiting for it.
    void cwdChanged(cwdChange(project, thread, previous));
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
    steer,
    instruct,
    rewind,
    compact,
    descendants,
    close,
    suspend,
    state,
    setCwd,
    resetCwd,
    git,
    hint,
    terminalResult,
    failTerminalResult,
    threadsClosing,
  };
};
