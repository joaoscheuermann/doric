// The records mirror's state (bundle isolation phase 3): the records, the
// state of each read, the connection, and the loads in flight. One store per
// mirror, so each window (and each test) holds its own.

import type { ConnectionStatus } from 'bundle/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { RecordsTree } from '../domain/tree.js';

/** The rejection a failed read holds: the error itself (R1). */
export type RecordsError = { readonly code: string; readonly message: string };

/** Where one read stands; its value is the tree's. */
export type ReadState =
  | { readonly status: 'loading' | 'ready' }
  | { readonly status: 'failed'; readonly error: RecordsError };

export interface RecordsState {
  readonly tree: RecordsTree;
  /** Whether a load of the Project list has settled with an answer. */
  readonly projectsListed: boolean;
  /** The Project list's read; absent until it is asked for. */
  readonly projects?: ReadState;
  /** The Threads read of each Project asked for. */
  readonly threads: Readonly<Record<string, ReadState>>;
  readonly connection: ConnectionStatus;
  /**
   * The sequence of the load in flight of each read: a load whose sequence
   * is no longer here settles without effect (R2).
   */
  readonly inFlight: {
    readonly projects?: number;
    readonly threads: Readonly<Record<string, number>>;
  };
}

export type RecordsStore = StoreApi<RecordsState>;

export const createRecordsStore = (
  connection: ConnectionStatus,
): RecordsStore =>
  createStore<RecordsState>()(() => ({
    tree: { projects: [], threadsByProject: {} },
    projectsListed: false,
    threads: {},
    connection,
    inFlight: { threads: {} },
  }));
