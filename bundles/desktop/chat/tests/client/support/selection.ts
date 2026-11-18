// The workspace as the chat reads it since bundle isolation 4(d): a probe that
// provides `workspace.selection/v1` (the selected Thread's ids) and the
// window's `runtime.records/v1` (the Thread records), passed to
// `openChatWindow` as `probe` and `recordsApi`. Both read the test's records
// on every call, so a test that changes them is read again once it calls
// `notify`, as the records mirror tells its subscribers of an update.

import {
  type ClientContext,
  type Disposable,
  defineMethod,
  defineService,
  disposableSchema,
  functionSchema,
  noInput,
} from 'bundle/contracts';
import type { RuntimeRecords, Thread } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';
import { z } from 'zod';

import type { Probe } from './window.js';

/** A Thread record as a test writes it: its id and Project at least. */
interface ThreadLike {
  readonly id?: string;
  readonly projectId?: string;
}

/**
 * `selected` is the reader's selected Thread (or nothing); `record` answers
 * the records' Thread of an id, the selected one alone by default.
 */
export const selectionProbe = (
  selected: () => unknown,
  record?: (id: string) => unknown,
): Probe & {
  readonly recordsApi: RuntimeRecords;
  /** Tells the records' subscribers that a record changed. */
  notify(): void;
} => {
  const listeners = new Set<() => void>();
  const current = (): {
    readonly projectId?: string;
    readonly threadId?: string;
  } => {
    const thread = selected() as ThreadLike | undefined;
    return thread?.id === undefined
      ? {}
      : {
          ...(thread.projectId === undefined
            ? {}
            : { projectId: thread.projectId }),
          threadId: thread.id,
        };
  };
  const threadOf = (id: string): Thread | undefined => {
    if (record) return record(id) as Thread | undefined;
    const thread = selected() as ThreadLike | undefined;
    return thread?.id === id ? (thread as Thread) : undefined;
  };
  const recordsApi: RuntimeRecords = {
    ...createRecordsApi(),
    thread: threadOf,
    subscribe: (listener): Disposable => {
      const heard = () => listener();
      listeners.add(heard);
      return { dispose: () => void listeners.delete(heard) };
    },
  };

  return {
    provides: ['workspace.selection/v1'],
    activate: ({ services }: ClientContext) => {
      services.provide(
        defineService('workspace.selection/v1', {
          current: defineMethod({
            input: noInput,
            output: z.unknown(),
            execute: current,
          }),
          subscribe: defineMethod({
            input: functionSchema<() => void>(),
            output: disposableSchema,
            execute: (): Disposable => ({ dispose: () => undefined }),
          }),
        }),
      );
    },
    recordsApi,
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
  };
};
