import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';

import type { ThreadControl, WorkspaceControl } from 'host';
import { type Sandbox, workspacePathKind } from 'sandbox';

import { eventJson } from '../events/serialization.js';
import { physicallyInside } from './cwd.js';
import { cwdRepoHint, threadGit } from './git-status.js';
import { nameFromPrompt } from './names.js';
import { delegatedResult } from './prompts.js';
import {
  type ProjectRuntime,
  type PromptJob,
  type RuntimeContext,
  subtreeIds,
  ThreadPersistenceError,
  type ThreadRuntime,
} from './runtime.js';
import {
  type CwdRefusal,
  type CwdRepo,
  type CwdResult,
  type InputSource,
  type InterruptResult,
  isTerminal,
  type Thread,
  type ThreadGit,
} from './types.js';

/** Owns independent prompt loops. Only queue/state mutations use the project lock. */
export const createThreadRunner = (context: RuntimeContext) => {
  const { exclusive, threads: store, publisher } = context;
  const publish = async (
    thread: ThreadRuntime,
    job: PromptJob,
    event: unknown,
  ) => {
    const value = await store.appendEvent(
      thread.thread.id,
      job.id,
      eventJson(event, context.generation().redactions()),
    );
    publisher.event(value);
  };
  const state = async (
    thread: ThreadRuntime,
    value: Thread['state'],
    promptId?: string,
    errorCode?: string,
  ) => {
    const updated = await store.setState(
      thread.thread.id,
      value,
      promptId,
      errorCode,
    );
    if (updated !== undefined) {
      thread.thread = updated;
      publisher.threadUpdated(updated);
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
    await publish(thread, job, {
      type: 'prompt.accepted',
      text: prompt,
      source,
    });
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
          String(eventJson(text, context.generation().redactions())),
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
  const run = async (project: ProjectRuntime, thread: ThreadRuntime) => {
    while (true) {
      const active = await exclusive(project.project.id, async () => {
        if (project.closing || thread.closing || project.lease === undefined)
          return undefined;
        const job = thread.jobs.shift();
        if (job === undefined) return undefined;
        const active = {
          job,
          controller: new AbortController(),
          finished: false,
        };
        thread.active = active;
        await state(thread, 'running', job.id);
        // The turn's rewind boundary is the history it is about to read.
        await store.saveCheckpoint(thread.thread.id, job.id);
        return active;
      });
      if (active === undefined) return;
      let status = 'completed';
      let text = '';
      let paused = false;
      try {
        text = await context.execute({
          thread: thread.thread,
          job: active.job,
          generation: context.generation(),
          sandbox: project.lease!.sandbox,
          signal: active.controller.signal,
          store,
          publisher,
          host: {
            threads: coordinate(project, thread, active.job),
            workspace: workspace(project, thread, active.job),
          },
        });
        active.controller.signal.throwIfAborted();
      } catch (error) {
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
      thread.closing ||
      project.closing ||
      project.lease === undefined ||
      thread.jobs.length === 0
    )
      return;
    thread.task = run(project, thread)
      .catch(async (error) => {
        thread.active?.controller.abort();
        // Fail closed on a persistence fault; never run further jobs with stale history.
        context.logger.error(
          { threadId: thread.thread.id, err: error },
          'Thread persistence failed',
        );
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
            context.logger.error(
              { threadId: thread.thread.id, err: error },
              'Prompt failure persistence failed',
            );
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
    for (const thread of targets) {
      thread.thread = { ...thread.thread, state: 'cancelling' };
      await state(thread, 'cancelling').catch(() => {
        context.logger.error(
          { threadId: thread.thread.id },
          'Thread cancellation persistence failed',
        );
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
              context.logger.error(
                { threadId: thread.thread.id },
                'Queued cancellation persistence failed',
              );
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
          context.logger.error(
            { threadId: thread.thread.id },
            'Thread termination persistence failed',
          );
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
        thread.pausing = 'host_stopped';
        thread.active.controller.abort();
      }
    }
    for (const thread of targets) {
      const task = thread.task;
      thread.ending = Promise.resolve()
        .then(async () => {
          // The aborted run settles here, writing its own pause before the
          // Thread is written back as ready.
          await task;
          await exclusive(project.project.id, () => state(thread, 'ready'));
        })
        .catch(() => {
          context.logger.error(
            { threadId: thread.thread.id },
            'Thread suspension persistence failed',
          );
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
  const setCwd = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    path: string,
  ): Promise<CwdResult> => {
    const lease = project.lease;
    if (project.closing || lease === undefined) return { status: 'inactive' };
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
      context.logger.debug(
        { threadId: thread.thread.id, err: error },
        'Thread Git hint probe failed',
      );
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
          const accepted = await enqueue(
            project,
            project.threads.get(created.thread.id)!,
            prompt,
            source,
          );
          if (accepted.status !== 'accepted')
            throw new Error('Thread cannot accept a task.');
          return { threadId: created.thread.id, promptId: accepted.promptId };
        }),
      list: (limit, cursor) =>
        exclusive(project.project.id, async () => {
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
