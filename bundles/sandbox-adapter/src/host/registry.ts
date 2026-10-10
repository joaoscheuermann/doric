import type { RunningMachine } from 'runtime/contracts';
import type { SandboxProvider, SandboxRuntime } from 'sandbox';

export type MachineProvider = 'docker' | 'firecracker';

export interface MachineRegistry {
  readonly provider: SandboxProvider;
  list(): readonly RunningMachine[];
  find(id: string): RunningMachine | undefined;
}

/**
 * Tracks successfully provisioned runtimes until their disposal completes
 * (moved unchanged from the kernel's `vms.ts`). A runtime whose disposal
 * fails stays listed.
 */
export const createMachineRegistry = (
  name: MachineProvider,
  provider: SandboxProvider,
): MachineRegistry => {
  const running = new Map<string, RunningMachine>();

  return {
    provider: {
      async provision(input) {
        const runtime = await provider.provision(input);

        running.set(runtime.id, { id: runtime.id, provider: name });

        return tracked(runtime, () => running.delete(runtime.id));
      },
    },
    list: () => [...running.values()],
    find: (id) => running.get(id),
  };
};

const tracked = (
  runtime: SandboxRuntime,
  remove: () => void,
): SandboxRuntime => {
  const stats = runtime.stats?.bind(runtime);
  return {
    id: runtime.id,
    exec: (input) => runtime.exec(input),
    ...(runtime.start === undefined
      ? {}
      : { start: runtime.start.bind(runtime) }),
    ...(stats === undefined ? {} : { stats }),
    putFile: (path, bytes) => runtime.putFile(path, bytes),
    getFile: (path) => runtime.getFile(path),
    ssh: () => runtime.ssh(),
    async dispose() {
      await runtime.dispose();
      remove();
    },
  };
};
