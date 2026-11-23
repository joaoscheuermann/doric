// `resources/v1` served through the router (phase 3, slice S50b): the host
// machine read in process, and the calling Project's container read over
// `runtime.lease/v1`'s `Stats`.

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { ContractError, isContractError } from 'bundle/contracts';
import { contractErrorOf, type HostContext } from 'bundle/host';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';

import type {
  ProjectResponseSchema,
  ResourcesService,
} from '../../contracts/gen/doric/resources/v1/resources_pb.js';
import { readSandboxResources } from '../container.js';
import { readHostResources } from '../machine.js';

/** The lease states `runtime.lease/v1` names in a not-ready failure. */
const LEASE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'unavailable',
  'expired',
  'missing',
]);

/** The `leaseStatus` detail of a not-ready lease failure, when it is one. */
const leaseStatusOf = (error: unknown): string | undefined => {
  if (!isContractError(error) || error.code !== 'unavailable') {
    return undefined;
  }
  const details = error.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const status: unknown = (details as { leaseStatus?: unknown }).leaseStatus;
  return typeof status === 'string' && LEASE_STATUSES.has(status)
    ? status
    : undefined;
};

/**
 * The calling Project's container reading over `runtime.lease/v1` (1.4.0):
 * one `Stats{target: {}}`, which inherits the handler call's scope, deadline
 * and signal.
 * - `{status: 'ready', value}`: `value` is `readSandboxResources` of the
 *   answered reading (`response` absent → `{status: 'unavailable', at}`).
 * - `{status: <leaseStatus>}` (no `value`) when `Stats` fails `unavailable`
 *   with the detail `leaseStatus`, one of `pending`, `unavailable`, `expired`
 *   or `missing`.
 * - Rejects with any other failure's `ContractError` (`contractErrorOf`),
 *   code kept: `invalid_input` when the call has no Project or Thread scope,
 *   `internal` when the provider's `stats()` failed, `unavailable` without
 *   `leaseStatus` when the runtime is unreachable (coordinator decision Q3).
 */
export const projectResourcesOf = async (
  lease: Client<typeof LeaseService>,
  now?: Date,
): Promise<MessageInitShape<typeof ProjectResponseSchema>> => {
  let answer: Awaited<ReturnType<typeof lease.stats>>;
  try {
    answer = await lease.stats({ target: {} });
  } catch (error) {
    const failure = contractErrorOf(error);
    const status = leaseStatusOf(failure);
    if (status === undefined) throw failure;
    return { status };
  }
  const reading = answer.response;
  return {
    status: 'ready',
    value: await readSandboxResources({ stats: async () => reading }, now),
  };
};

export interface ResourcesServiceHandle {
  /**
   * `resources/v1` (1.0.0):
   * - `Host{}` → `readHostResources()` (the process keeps one CPU sample: the
   *   first answer of a process has no `cpuPercent`);
   * - `Project{}` → `projectResourcesOf(lease)`.
   *
   * Before `activate`, `Project` fails `unavailable`; `Host` needs no client.
   */
  readonly implementation: ServiceImpl<typeof ResourcesService>;
  /** Binds the `runtime.lease/v1` client; makes no call. */
  activate(context: Pick<HostContext, 'services'>): void;
}

export const createResourcesService = (): ResourcesServiceHandle => {
  let lease: Client<typeof LeaseService> | undefined;

  return {
    implementation: {
      host: async () => readHostResources(),
      project: async () => {
        if (lease === undefined) {
          throw new ContractError(
            'unavailable',
            'The resources monitor is not ready.',
          );
        }
        return await projectResourcesOf(lease);
      },
    },
    activate: (context) => {
      lease = context.services.use(LeaseService);
    },
  };
};
