// What `papercraft`'s host logic calls outside itself (S57 D1): the `files/v1`
// reads, the Project's sandbox lease, the Thread log and instruct, and the
// `papercraft.cwd/v1` append. The kernel serves them over `services`; the
// process over the router.

import { type Call, EventsV1, type Services } from 'bundle/contracts';
import {
  RuntimeLeaseV1,
  RuntimeThreadsV1,
  type SteerResult,
} from 'runtime/contracts';

import {
  cwdEvent,
  type FilesContentRead,
  FilesV1,
  type LeaseOutcome,
} from '../contracts/index.js';
import type { RunnerSandbox } from './sandbox.js';

/** Where a `files/v1` read runs: the Project, and the call it is part of (none: outside every call, D2). */
export interface ReadAt {
  readonly projectId: string;
  readonly call?: Call;
}

/** One file's bytes as `papercraft` reads them; `truncated` when the file was cut at the reader's bound. */
export type BytesReadOutcome =
  | {
      readonly status: 'read';
      readonly bytes: Uint8Array;
      readonly truncated: boolean;
    }
  | { readonly status: 'not_found' | 'not_file' | 'invalid_path' };

/**
 * The `files/v1` reads. Each answers the lease state and, when `ready`, the read; rejects with the provider's
 * `ContractError` (a routed failure through `contractErrorOf`). Never acquires a lease.
 */
export interface PapercraftFiles {
  /** One file as bounded UTF-8 text (`Content{path}`). */
  content(path: string, at: ReadAt): Promise<LeaseOutcome<FilesContentRead>>;
  /** One file's exact bytes under `files/v1`'s bound (kernel: base64 `content`; process: `ReadBytes`, D3). */
  readBytes(path: string, at: ReadAt): Promise<LeaseOutcome<BytesReadOutcome>>;
}

/** Runs runner tasks on a Project's current sandbox. */
export interface PapercraftLease {
  /**
   * Runs `task` on the sandbox the Project holds now, never acquiring one; outside every call (D2). Answers
   * `{status: 'ready', value}`, or `{status}` (`pending`, `unavailable`, `expired`, `missing`) when the lease could not
   * run it (the first lease failure ends the run; later sandbox steps reject with it). Rejects with any other failure
   * as `contractErrorOf` reads it.
   */
  run<T>(
    projectId: string,
    task: (sandbox: RunnerSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>>;
}

/** One stored row of a Thread's log as the library hooks read it (`event`: the stored JSON body). */
export interface PapercraftRow {
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
}

/** The library instruct (D28): retained, under the started prompt. */
export interface LibraryInstruct {
  readonly id: string;
  readonly prompt: string;
  readonly reason: 'library';
  readonly promptId: string;
  readonly retain: true;
}

/** The `runtime.threads/v1` operations `papercraft` uses; rejections are the provider's `ContractError`. */
export interface PapercraftThreads {
  /** Rows after `afterSequence` in order and the log's last sequence; `undefined` when the Thread has no log. */
  eventsAfter(
    threadId: string,
    afterSequence: number,
    call?: Call,
  ): Promise<
    | {
        readonly events: readonly PapercraftRow[];
        readonly lastSequence: number;
      }
    | undefined
  >;
  instruct(input: LibraryInstruct, call?: Call): Promise<SteerResult>;
}

/** What `papercraft`'s host logic calls outside itself. */
export interface PapercraftPorts {
  readonly files: PapercraftFiles;
  readonly lease: PapercraftLease;
  readonly threads: PapercraftThreads;
  /**
   * Appends one `papercraft.cwd/v1` row `{cwd}` under `scope`. Resolves once `events/v1` accepted it; rejects with its
   * `ContractError` (`invalid_scope` while no sink serves the stream, `invalid_input` for an empty `cwd`). Appends
   * nothing on a rejection.
   */
  appendCwd(
    scope: {
      readonly projectId: string;
      readonly threadId: string;
      readonly promptId: string;
    },
    cwd: string,
    call?: Call,
  ): Promise<void>;
}

/**
 * The kernel's ports: each method is today's `services.use(...)` call, made when it runs: `content`/`readBytes` use
 * `call?.scope ?? {projectId}` (base64 `content` for bytes), `run` is `withLease`, `eventsAfter` is `threadEvents`
 * mapped to `{events, lastSequence}`, `instruct`/`appendCwd` as `library.ts` calls them. Kernel only; leaves in group F.
 */
export const kernelPapercraftPorts = (services: Services): PapercraftPorts => {
  const content = (
    input: { readonly path: string; readonly encoding?: 'base64' },
    { projectId, call }: ReadAt,
  ): Promise<LeaseOutcome<FilesContentRead>> =>
    services.use(FilesV1, call?.scope ?? { projectId }).content(input, call);

  return {
    files: {
      content: (path, at) => content({ path }, at),
      readBytes: async (path, at) => {
        const outcome = await content({ path, encoding: 'base64' }, at);
        if (outcome.status !== 'ready') return outcome;

        const read = outcome.value;

        return read.status === 'read'
          ? {
              status: 'ready',
              value: {
                status: 'read',
                bytes: Buffer.from(read.content, 'base64'),
                truncated: read.truncated,
              },
            }
          : { status: 'ready', value: read };
      },
    },
    lease: {
      run: (projectId, task) =>
        services.use(RuntimeLeaseV1, { projectId }).withLease(task),
    },
    threads: {
      eventsAfter: async (threadId, afterSequence) => {
        const log = await services
          .use(RuntimeThreadsV1)
          .threadEvents({ id: threadId, afterSequence });

        return log === undefined
          ? undefined
          : { events: log.events, lastSequence: log.lastSequence };
      },
      instruct: (input) => services.use(RuntimeThreadsV1).instruct(input),
    },
    appendCwd: async (scope, cwd) => {
      await services.use(EventsV1, scope).append(cwdEvent, { cwd });
    },
  };
};
