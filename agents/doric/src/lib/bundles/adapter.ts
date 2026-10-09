import type { EmbeddedBundle } from 'bundle';
import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type HostContext,
} from 'bundle/contracts';
import type { Host } from 'host';
import {
  RuntimeLeaseV1,
  RuntimeThreadsV1,
  RuntimeWorkspaceV1,
  runtimeLeaseMethods,
  runtimeThreadsMethods,
  runtimeWorkspaceMethods,
} from 'runtime/contracts';
import type { Sandbox } from 'sandbox';
import { TerminalV1, terminalMethods } from 'terminal/contracts';

/** The prompt a binding serves: what every adapter call's scope must name. */
export interface PromptScope {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
}

/** The per-prompt capabilities the runner built for one execution. */
export interface PromptBinding {
  readonly host: Host;
  readonly sandbox: Sandbox;
}

/**
 * The provisional provider of `runtime.threads/v1`, `runtime.workspace/v1`,
 * `runtime.lease/v1` and `terminal/v1`. It forwards every method one to one to
 * the prompt-scoped `Host` facade and sandbox the runner builds, so the bundle
 * tools reach exactly what they reached as `(sandbox, host)` arguments. It
 * leaves as the extracted `runtime` (stage 5) and `terminal` (stage 10)
 * bundles take these contracts.
 */
export interface HostAdapter {
  /** Embedded bundle `host-adapter`, always enabled outside the composition. */
  readonly bundle: EmbeddedBundle;
  /** Binds the prompt's Host and sandbox to its scope until `release` runs. */
  attach(scope: PromptScope, binding: PromptBinding): () => void;
}

const inactive = () => new Error('Thread control is no longer active.');

const contracts = [
  RuntimeThreadsV1.id,
  RuntimeWorkspaceV1.id,
  RuntimeLeaseV1.id,
  TerminalV1.id,
] as const;

const version = '1.0.0';

const describe = ({ id, root }: Sandbox) => ({ id, root });

export const createHostAdapter = (): HostAdapter => {
  const bindings = new Map<string, PromptScope & PromptBinding>();

  /** The binding of the prompt `call` belongs to; an ended prompt has none. */
  const bound = (call: Call): PromptScope & PromptBinding => {
    const promptId = call.scope?.promptId;
    const binding = promptId === undefined ? undefined : bindings.get(promptId);

    if (
      binding === undefined ||
      binding.threadId !== call.scope?.threadId ||
      binding.projectId !== call.scope?.projectId
    )
      throw inactive();

    return binding;
  };

  const threads = defineService(RuntimeThreadsV1, {
    spawn: defineMethod({
      input: runtimeThreadsMethods.spawn.input,
      output: runtimeThreadsMethods.spawn.output,
      execute: (prompt, call) => bound(call).host.threads.spawn(prompt),
    }),
    list: defineMethod({
      input: runtimeThreadsMethods.list.input,
      output: runtimeThreadsMethods.list.output,
      execute: ([limit, cursor], call) =>
        bound(call).host.threads.list(limit, cursor),
    }),
    get: defineMethod({
      input: runtimeThreadsMethods.get.input,
      output: runtimeThreadsMethods.get.output,
      execute: (threadId, call) => bound(call).host.threads.get(threadId),
    }),
    events: defineMethod({
      input: runtimeThreadsMethods.events.input,
      output: runtimeThreadsMethods.events.output,
      execute: ([threadId, afterSequence, limit], call) =>
        bound(call).host.threads.events(threadId, afterSequence, limit),
    }),
    send: defineMethod({
      input: runtimeThreadsMethods.send.input,
      output: runtimeThreadsMethods.send.output,
      execute: ([threadId, prompt], call) =>
        bound(call).host.threads.send(threadId, prompt),
    }),
    interrupt: defineMethod({
      input: runtimeThreadsMethods.interrupt.input,
      output: runtimeThreadsMethods.interrupt.output,
      execute: ([threadId, promptId], call) =>
        bound(call).host.threads.interrupt(threadId, promptId),
    }),
    terminate: defineMethod({
      input: runtimeThreadsMethods.terminate.input,
      output: runtimeThreadsMethods.terminate.output,
      execute: (threadId, call) => bound(call).host.threads.terminate(threadId),
    }),
  });

  const workspace = defineService(RuntimeWorkspaceV1, {
    cwd: defineMethod({
      input: runtimeWorkspaceMethods.cwd.input,
      output: runtimeWorkspaceMethods.cwd.output,
      execute: async (_input, call) => bound(call).host.workspace.cwd(),
    }),
    setCwd: defineMethod({
      input: runtimeWorkspaceMethods.setCwd.input,
      output: runtimeWorkspaceMethods.setCwd.output,
      execute: (path, call) => bound(call).host.workspace.setCwd(path),
    }),
  });

  const lease = defineService(RuntimeLeaseV1, {
    describe: defineMethod({
      input: runtimeLeaseMethods.describe.input,
      output: runtimeLeaseMethods.describe.output,
      execute: async (_input, call) => describe(bound(call).sandbox),
    }),
    exec: defineMethod({
      input: runtimeLeaseMethods.exec.input,
      output: runtimeLeaseMethods.exec.output,
      execute: async (input, call) => {
        // No abort signal reaches the sandbox, as no tool ever passed one.
        const result = await bound(call).sandbox.exec(input);

        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    }),
    readFile: defineMethod({
      input: runtimeLeaseMethods.readFile.input,
      output: runtimeLeaseMethods.readFile.output,
      execute: (path, call) => bound(call).sandbox.readFile(path),
    }),
    writeFile: defineMethod({
      input: runtimeLeaseMethods.writeFile.input,
      output: runtimeLeaseMethods.writeFile.output,
      execute: async ([path, content], call) => {
        await bound(call).sandbox.writeFile(path, content);
      },
    }),
  });

  const terminal = defineService(TerminalV1, {
    run: defineMethod({
      input: terminalMethods.run.input,
      output: terminalMethods.run.output,
      execute: (input, call) => {
        const terminals = bound(call).host.terminals;

        // A facade without live terminals leaves the tool its plain-command
        // fallback, exactly as when no terminal provider exists at all.
        if (terminals === undefined)
          throw new ContractError(
            'unavailable',
            'This prompt has no live terminals.',
          );

        return terminals.run(input);
      },
    }),
  });

  const id = 'host-adapter';

  return {
    bundle: {
      manifest: {
        manifestVersion: 1,
        id,
        version: '0.0.0',
        engines: { doric: '^1.0.0' },
        description:
          'Provisional provider of the runtime and terminal contracts over the host.',
        provides: contracts.map((contract) => `${contract}@${version}`),
        requires: [],
      },
      descriptor: {
        descriptorVersion: 1,
        bundle: { id, version: '0.0.0' },
        contracts: contracts.map((contract) => ({
          id: contract,
          version,
          kind: 'service' as const,
          environment: 'host' as const,
          cardinality: 'one' as const,
          local: false,
          schema: `schemas/${contract}.json`,
        })),
      },
      host: {
        activate: ({ services }: HostContext) => {
          services.provide(threads);
          services.provide(workspace);
          services.provide(lease);
          services.provide(terminal);
        },
      },
    },
    attach: (scope, binding) => {
      const entry = { ...scope, ...binding };

      bindings.set(scope.promptId, entry);

      return () => {
        // A late release of a paused run never drops the binding of the run
        // that resumed the same prompt.
        if (bindings.get(scope.promptId) === entry)
          bindings.delete(scope.promptId);
      };
    },
  };
};
