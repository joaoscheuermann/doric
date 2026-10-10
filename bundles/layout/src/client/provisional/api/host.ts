// The host contracts the provisional features call over the client → host
// bridge (stage 9 §1.2 revised): the lease reads of `runtime.lease/v1`, the
// manual terminals of `runtime.terminals/v1`, Thread usage on
// `runtime.threads/v1` and the host machine on `resources/v1`. As in
// `../../api/host.ts`, each reference is built from its contract ID with the
// owner's types only, because a window's import map is not guaranteed to
// serve a host bundle's contracts module. Stage 10 moves these reads to the
// `files`, `git`, `terminal` and `resources` bundles.

import { ref } from 'bundle/contracts';
import type { Resources } from 'resources/contracts';
import type {
  RuntimeLease,
  RuntimeTerminals,
  RuntimeThreads,
} from 'runtime/contracts';

/** `runtime.lease/v1`: the lease reads, scoped by Project or by Thread. */
export const RuntimeLeaseV1 = ref<RuntimeLease>('runtime.lease/v1');

/** `runtime.terminals/v1`: manual terminals and their stream (1.1.0). */
export const RuntimeTerminalsV1 = ref<RuntimeTerminals>('runtime.terminals/v1');

/** `resources/v1`: the machine the host runs on. */
export const ResourcesV1 = ref<Resources>('resources/v1');

/** `runtime.threads/v1`, for `usage` only. */
export const RuntimeThreadsUsageV1 = ref<RuntimeThreads>('runtime.threads/v1');

/** The lease reads the provisional features make. */
export type LeaseHost = Pick<
  RuntimeLease,
  | 'files'
  | 'tree'
  | 'file'
  | 'diff'
  | 'changes'
  | 'fileDiff'
  | 'resources'
  | 'git'
  | 'branches'
>;

/** The terminal controls the provisional features make. */
export type TerminalsHost = Pick<
  RuntimeTerminals,
  'list' | 'create' | 'snapshot' | 'input' | 'resize' | 'stop' | 'watchProject'
>;

export type UsageHost = Pick<RuntimeThreads, 'usage'>;

export type ResourcesHost = Pick<Resources, 'host'>;
