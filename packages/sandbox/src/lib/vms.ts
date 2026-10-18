import type { SandboxProvider, SandboxRuntime } from './types/sandbox.js';

export type VmProvider = 'docker' | 'firecracker';

export type RunningVm = {
  readonly id: string;
  readonly provider: VmProvider;
};

export type VmRegistry = {
  /** The wrapped provider: what the sandbox pool provisions through. */
  readonly provider: SandboxProvider;
  list(): readonly RunningVm[];
  find(id: string): RunningVm | undefined;
};

/**
 * Tracks successfully provisioned runtimes until their disposal completes
 * (moved from the kernel's `vms.ts`). A runtime whose disposal fails stays
 * listed.
 */
export const createVmRegistry = (
  name: VmProvider,
  provider: SandboxProvider,
): VmRegistry => {
  const running = new Map<string, RunningVm>();

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
