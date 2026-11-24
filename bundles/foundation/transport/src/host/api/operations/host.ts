import type { Tools } from 'bundle/contracts';
import type { HostResources } from 'resources/contracts';
import type { RunningMachine, VmSsh } from 'runtime/contracts';

import { ok, refused } from '../../routes/input.js';
import type { ApiAnswer, RouteInput } from '../answer.js';
import type { TransportPorts } from '../ports.js';

type Op<V> = (input: RouteInput) => Promise<ApiAnswer<V>>;

/** One tool as `GET /tools` lists it. */
export type ToolListing = Pick<
  Awaited<ReturnType<Tools['list']>>[number]['tool'],
  'name' | 'description' | 'settings'
>;

/**
 * The `/tools`, `/resources` and `/vms` route bodies over the ports. The tools
 * are the active generation's, with the configuration fields each declares
 * (kernel-local metadata: the read executes nothing). The host resources hold
 * no lease, so the monitor can poll them without a Project. The VM reads
 * observe the sandbox provider's running machines.
 */
export const hostOperations = ({
  tools,
  resources,
  sandbox,
  runtime,
}: Pick<TransportPorts, 'tools' | 'resources' | 'sandbox' | 'runtime'>): {
  /** `GET /tools`. */
  readonly tools: Op<{ readonly tools: readonly ToolListing[] }>;
  /** `GET /resources`. */
  readonly resources: Op<HostResources>;
  /** `GET /vms`. */
  readonly vms: Op<readonly RunningMachine[]>;
  /** `GET /vms/:id/ssh`. */
  readonly vmSsh: Op<{ readonly vm: RunningMachine } & VmSsh>;
} => ({
  tools: async () => {
    // Called from another process the list arrives as a promise of the list.
    const registered = await tools.list();

    return ok({
      tools: registered.map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        settings: tool.settings,
      })),
    });
  },
  resources: async () => ok(await resources().host()),
  vms: async () => ok(await sandbox.machines()),
  vmSsh: async ({ params }) => {
    const vm = await sandbox.machine(params.id ?? '');

    if (vm === undefined) {
      return refused({
        status: 404,
        code: 'vm_not_found',
        message: 'The VM was not found.',
      });
    }

    const access = await runtime.vmSsh(vm.id);

    if (access === undefined) {
      return refused({
        status: 409,
        code: 'vm_ssh_unavailable',
        message: 'SSH is unavailable for this VM.',
      });
    }

    return ok({ vm, ...access });
  },
});
