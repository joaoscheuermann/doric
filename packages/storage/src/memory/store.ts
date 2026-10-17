import type { StorageIdentity } from 'bundle/contracts';

/** A declared index, as the backend keeps it. */
export interface MemoryIndex {
  readonly name: string;
  readonly fields: readonly string[];
  readonly unique: boolean;
}

export interface MemoryDocument {
  readonly revision: number;
  readonly value: unknown;
  readonly updatedAt: string;
}

export interface MemoryStreamEntry {
  readonly sequence: number;
  readonly value: unknown;
  readonly createdAt: string;
}

export interface MemoryTruncation {
  readonly afterSequence: number;
  readonly atSequence: number;
  /** The commit that truncated. */
  readonly position: number;
}

export interface MemoryStream {
  lastSequence: number;
  entries: MemoryStreamEntry[];
  truncations: MemoryTruncation[];
}

export interface MemoryCommit {
  readonly position: number;
  readonly documents: readonly { readonly type: string; readonly id: string }[];
  readonly streams: readonly string[];
  readonly truncated: readonly string[];
  readonly dropped: readonly string[];
}

/**
 * The state behind the memory backends. It outlives any one backend
 * instance, so a test can drop an instance (a "crash") and open another over
 * the same data. Callers read and write it only through the backends.
 */
export interface MemoryStore {
  /** Declared types and their indexes. */
  readonly types: Map<string, readonly MemoryIndex[]>;
  /** type → id → document. */
  readonly documents: Map<string, Map<string, MemoryDocument>>;
  /** type → index name → document id → key. */
  readonly indexEntries: Map<string, Map<string, Map<string, Uint8Array>>>;
  readonly streams: Map<string, MemoryStream>;
  /** The commit feed, in position order. */
  readonly commits: MemoryCommit[];
  /** sha256 hex → bytes. */
  readonly blobs: Map<string, Uint8Array>;
  /** The reserved identity record; created by the first `identity()`. */
  identity: StorageIdentity | undefined;
}

export const createMemoryStore = (): MemoryStore => ({
  types: new Map(),
  documents: new Map(),
  indexEntries: new Map(),
  streams: new Map(),
  commits: [],
  blobs: new Map(),
  identity: undefined,
});
