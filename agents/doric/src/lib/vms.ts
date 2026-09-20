import type { SandboxProvider, SandboxRuntime } from 'sandbox';

export type VmProvider = 'docker' | 'firecracker';

export type RunningVm = {
  readonly id: string;
  readonly provider: VmProvider;
};

export type VmRegistry = {
  readonly provider: SandboxProvider;
  list(): readonly RunningVm[];

  find(id: string): RunningVm | undefined;
};

/** Tracks successfully provisioned runtimes until their disposal completes. */
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
): SandboxRuntime => ({
  id: runtime.id,
  exec: (input) => runtime.exec(input),
  putFile: (path, bytes) => runtime.putFile(path, bytes),
  getFile: (path) => runtime.getFile(path),
  ssh: () => runtime.ssh(),
  async dispose() {
    await runtime.dispose();

    remove();
  },
});
