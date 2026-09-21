import { randomUUID } from 'node:crypto';

import type { ThreadCoordination } from './coordination.js';
import { eventJson } from '../events/serialization.js';
import { nameFromPrompt } from './names.js';
import {
  subtreeIds,
  ThreadPersistenceError,
  type ProjectRuntime,
  type PromptJob,
  type RuntimeContext,
  type ThreadRuntime,
} from './runtime.js';
import {
  isTerminal,
  type InputSource,
  type InterruptResult,
  type Thread,
} from './types.js';

/** Owns independent prompt loops. Only queue/state mutations use the project lock. */
export const createThreadRunner = (context: RuntimeContext) => {
  const { exclusive, threads: store, publisher } = context;
  const publish = async (
    project: ProjectRuntime,
    thread: ThreadRuntime,
    job: PromptJob,
    event: unknown,
  ) => {
    const value = await store.appendEvent(
      thread.thread.id,
      job.id,
      eventJson(event, project.generation.redactions()),
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
    await publish(project, thread, job, { type: 'prompt.accepted', source });
    thread.jobs.push(job);
    start(project, thread);
    return { status: 'accepted' as const, promptId: job.id };
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
        [
          '# Delegated task result',
          '',
          `Child thread: ${thread.thread.id}`,
          `Child prompt: ${job.id}`,
          `Originating prompt: ${source.promptId}`,
          `Status: ${status}`,
          '',
          '## Result',
          '',
          String(eventJson(text, project.generation.redactions())),
        ].join('\n'),
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
    await publish(project, thread, job, {
      type: 'prompt.finished',
      status,
      text,
      source: job.source,
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
        return active;
      });
      if (active === undefined) return;
      let status = 'completed';
      let text = '';
      try {
        text = await context.execute({
          thread: thread.thread,
          job: active.job,
          generation: project.generation,
          sandbox: project.lease!.sandbox,
          signal: active.controller.signal,
          store,
          publisher,
          coordination: coordinate(project, thread, active.job),
        });
        active.controller.signal.throwIfAborted();
      } catch (error) {
        if (error instanceof ThreadPersistenceError) throw error;
        status = active.controller.signal.aborted ? 'cancelled' : 'failed';
        text =
          status === 'cancelled'
            ? 'The prompt was cancelled.'
            : 'The prompt failed.';
        await publish(project, thread, active.job, {
          type: status === 'cancelled' ? 'agent.cancelled' : 'agent.failed',
          error,
        });
      }
      active.finished = true;
      await finishJob(project, thread, active.job, status, text);
      await exclusive(project.project.id, async () => {
        thread.active = undefined;
        if (!thread.closing && !project.closing) await state(thread, 'ready');
      });
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
      .catch(async () => {
        thread.active?.controller.abort();
        // Fail closed on a persistence fault; never run further jobs with stale history.
        context.logger.error(
          { threadId: thread.thread.id },
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
          ).catch(() => {
            context.logger.error(
              { threadId: thread.thread.id },
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
    if (parentThreadId !== undefined) {
      const parent = project.threads.get(parentThreadId);
      if (parent === undefined) return { status: 'invalid_parent' as const };
      if (parent.closing) return { status: 'inactive' as const };
    }
    const record = await store.create(project.project.id, name, parentThreadId);
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
  ): InterruptResult => {
    if (thread.closing) return 'inactive';
    if (thread.active?.job.id !== promptId || thread.active.finished)
      return 'not_running';
    thread.active.controller.abort();
    return 'interrupted';
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
              await publish(project, thread, job, {
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
  const coordinate = (
    project: ProjectRuntime,
    parent: ThreadRuntime,
    job: PromptJob,
  ): ThreadCoordination => {
    const allowed = () => {
      if (
        project.closing ||
        parent.closing ||
        parent.active?.job.id !== job.id ||
        parent.active.finished ||
        parent.active.controller.signal.aborted
      )
        throw new Error('Thread control is no longer active.');
    };
    const child = async (id: string) => {
      allowed();
      const record = await store.find(id);
      if (
        record?.thread.parentThreadId !== parent.thread.id ||
        record.thread.projectId !== project.project.id
      )
        throw new Error('Thread is not a direct child.');
      return record.thread;
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
      get: (id, afterSequence) =>
        exclusive(project.project.id, async () => ({
          thread: await child(id),
          events: await store.eventsAfter(id, afterSequence),
        })),
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
  return { start, enqueue, create, interrupt, descendants, close, state };
};
