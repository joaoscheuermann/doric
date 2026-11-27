// What `papercraft`'s host logic calls outside itself (S57 D1): the `files/v1`
// reads, the Project's sandbox lease, the Thread log and instruct, and the
// `papercraft.cwd/v1` append. The process serves them over the router.

import type { Call } from 'bundle/contracts';
import type { SteerResult } from 'runtime/contracts';

import type { FilesContentRead, LeaseOutcome } from '../contracts/index.js';
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
  /** One file's exact bytes under `files/v1`'s bound (`ReadBytes`, D3). */
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
