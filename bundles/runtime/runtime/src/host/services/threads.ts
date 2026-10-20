import { defineMethod, defineService } from 'bundle/contracts';

import {
  runtimeThreadsMethods as methods,
  RuntimeThreadsV1,
} from '../../contracts/threads.js';
import type { Bindings } from '../domain/bindings.js';
import type { WorkspaceService } from '../domain/types.js';
import type { ThreadStore } from '../store/types.js';
import type { Watches } from './watches.js';

/*
 * runtime.threads/v1 (design 57 §2.3): the stage-1 child controls, bound to
 * the calling prompt as the stage-1 adapter bound them, plus the
 * WorkspaceService.threads operations, which ignore `call.scope`.
 */
export const threadsService = ({
  service,
  threads,
  bindings,
  watches,
}: {
  readonly service: WorkspaceService;
  readonly threads: ThreadStore;
  readonly bindings: Bindings;
  readonly watches: Watches;
}) =>
  defineService(RuntimeThreadsV1, {
    spawn: defineMethod({
      ...methods.spawn,
      execute: ([prompt, title], call) =>
        bindings.bound(call).host.threads.spawn(prompt, title),
    }),
    list: defineMethod({
      ...methods.list,
      execute: ([limit, cursor], call) =>
        bindings.bound(call).host.threads.list(limit, cursor),
    }),
    get: defineMethod({
      ...methods.get,
      execute: (threadId, call) =>
        bindings.bound(call).host.threads.get(threadId),
    }),
    events: defineMethod({
      ...methods.events,
      execute: ([threadId, afterSequence, limit], call) =>
        bindings
          .bound(call)
          .host.threads.events(threadId, afterSequence, limit),
    }),
    send: defineMethod({
      ...methods.send,
      execute: ([threadId, prompt], call) =>
        bindings.bound(call).host.threads.send(threadId, prompt),
    }),
    restart: defineMethod({
      ...methods.restart,
      execute: ([threadId, prompt], call) =>
        bindings.bound(call).host.threads.restart(threadId, prompt),
    }),
    interrupt: defineMethod({
      ...methods.interrupt,
      execute: ([threadId, promptId], call) =>
        bindings.bound(call).host.threads.interrupt(threadId, promptId),
    }),
    terminate: defineMethod({
      ...methods.terminate,
      execute: (threadId, call) =>
        bindings.bound(call).host.threads.terminate(threadId),
    }),
    createThread: defineMethod({
      expose: 'desktop',
      ...methods.createThread,
      execute: ({ projectId, name, parentThreadId }) =>
        service.threads.create(projectId, name, parentThreadId),
    }),
    thread: defineMethod({
      expose: 'desktop',
      ...methods.thread,
      execute: (id) => service.threads.find(id),
    }),
    storedThread: defineMethod({
      ...methods.storedThread,
      execute: (id) => threads.record(id),
    }),
    threads: defineMethod({
      expose: 'desktop',
      ...methods.threads,
      execute: ({ projectId, limit, cursor, parentThreadId }) =>
        service.threads.list(projectId, limit, cursor, parentThreadId),
    }),
    projectThreads: defineMethod({
      ...methods.projectThreads,
      execute: (projectId) => threads.listByProject(projectId),
    }),
    renameThread: defineMethod({
      expose: 'desktop',
      ...methods.renameThread,
      execute: ({ id, name }) => service.threads.rename(id, name),
    }),
    setThreadCwd: defineMethod({
      expose: 'desktop',
      ...methods.setThreadCwd,
      execute: ({ id, cwd }) => service.threads.setCwd(id, cwd),
    }),
    prompt: defineMethod({
      expose: 'desktop',
      ...methods.prompt,
      execute: ({ id, prompt }) => service.threads.prompt(id, prompt),
    }),
    retry: defineMethod({
      expose: 'desktop',
      ...methods.retry,
      execute: ({ id }) => service.threads.retry(id),
    }),
    steer: defineMethod({
      expose: 'desktop',
      ...methods.steer,
      execute: ({ id, prompt, promptId, interrupt }) =>
        service.threads.steer(id, prompt, {
          promptId,
          ...(interrupt === undefined ? {} : { interrupt }),
        }),
    }),
    resume: defineMethod({
      expose: 'desktop',
      ...methods.resume,
      execute: ({ id, promptId }) => service.threads.resume(id, promptId),
    }),
    rewind: defineMethod({
      expose: 'desktop',
      ...methods.rewind,
      execute: ({ id, promptId, prompt }) =>
        service.threads.rewind(id, promptId, prompt),
    }),
    compact: defineMethod({
      expose: 'desktop',
      ...methods.compact,
      execute: ({ id }) => service.threads.compact(id),
    }),
    threadEvents: defineMethod({
      ...methods.threadEvents,
      execute: ({ id, afterSequence }) =>
        service.threads.events(id, afterSequence),
    }),
    storedEventsAfter: defineMethod({
      ...methods.storedEventsAfter,
      execute: ({ id, afterSequence }) =>
        threads.eventsAfter(id, afterSequence),
    }),
    pause: defineMethod({
      expose: 'desktop',
      ...methods.pause,
      execute: ({ id, promptId }) => service.threads.interrupt(id, promptId),
    }),
    terminateThread: defineMethod({
      expose: 'desktop',
      ...methods.terminateThread,
      execute: (id) => service.threads.terminate(id),
    }),
    deleteThread: defineMethod({
      expose: 'desktop',
      ...methods.deleteThread,
      execute: (id) => service.threads.delete(id),
    }),
    queue: defineMethod({
      expose: 'desktop',
      ...methods.queue,
      execute: (id) => service.threads.queue(id),
    }),
    resumeQueue: defineMethod({
      expose: 'desktop',
      ...methods.resumeQueue,
      execute: (id) => service.threads.resumeQueue(id),
    }),
    queuedPrompt: defineMethod({
      expose: 'desktop',
      ...methods.queuedPrompt,
      execute: ({ id, promptId }) => service.threads.queuedPrompt(id, promptId),
    }),
    editQueued: defineMethod({
      expose: 'desktop',
      ...methods.editQueued,
      execute: ({ id, promptId, text, revision }) =>
        service.threads.editQueued(id, promptId, text, revision),
    }),
    removeQueued: defineMethod({
      expose: 'desktop',
      ...methods.removeQueued,
      execute: ({ id, promptId }) => service.threads.removeQueued(id, promptId),
    }),
    usage: defineMethod({
      expose: 'desktop',
      ...methods.usage,
      execute: (id) => service.threads.usage(id),
    }),
    enqueueTerminalResult: defineMethod({
      ...methods.enqueueTerminalResult,
      execute: (input) => service.threads.terminalResult(input),
    }),
    failTerminalResult: defineMethod({
      ...methods.failTerminalResult,
      execute: ({ threadId }) => service.threads.failTerminalResult(threadId),
    }),
    watchThread: defineMethod({
      expose: 'desktop',
      ...methods.watchThread,
      execute: ([input, listener]) => watches.thread(input, listener),
    }),
  });
