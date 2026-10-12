import { defineMethod, defineService } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type Host,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
  runtimeLeaseMethods,
  runtimeWorkspaceMethods,
} from 'runtime/contracts';
import type { Sandbox } from 'sandbox';
import type { Tool, ToolDefinitionObject, ToolInput, ToolOutput } from 'tool';

/** The sandbox operations the fake lease forwards. */
export type LeasedSandbox = Pick<
  Sandbox,
  'id' | 'root' | 'exec' | 'readFile' | 'writeFile'
>;

/**
 * Fake providers of the contracts this bundle requires, standing for the
 * prompt's lease and Thread exactly as the host adapter does: the lease
 * forwards to `sandbox` and the working directory to `host.workspace`.
 */
const providers = (sandbox: LeasedSandbox, host: Host) => [
  // By id: the stage-1 methods only; withThread (1.1.0) has no fake here.
  defineService(RuntimeWorkspaceV1.id, {
    cwd: defineMethod({
      input: runtimeWorkspaceMethods.cwd.input,
      output: runtimeWorkspaceMethods.cwd.output,
      execute: async () => host.workspace.cwd(),
    }),
    setCwd: defineMethod({
      input: runtimeWorkspaceMethods.setCwd.input,
      output: runtimeWorkspaceMethods.setCwd.output,
      execute: (path) => host.workspace.setCwd(path),
    }),
  }),
  // Stage-1 methods only: the lease reads have no fake here.
  defineService(RuntimeLeaseV1.id, {
    describe: defineMethod({
      input: runtimeLeaseMethods.describe.input,
      output: runtimeLeaseMethods.describe.output,
      execute: async () => ({ id: sandbox.id, root: sandbox.root }),
    }),
    exec: defineMethod({
      input: runtimeLeaseMethods.exec.input,
      output: runtimeLeaseMethods.exec.output,
      execute: async (input) => {
        const result = await sandbox.exec(input);

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
      execute: (path) => sandbox.readFile(path),
    }),
    writeFile: defineMethod({
      input: runtimeLeaseMethods.writeFile.input,
      output: runtimeLeaseMethods.writeFile.output,
      execute: async ([path, content]) => {
        await sandbox.writeFile(path, content);
      },
    }),
  }),
];

/** The agent-loop tool of `definition` for one prompt over a fake lease and Thread. */
export const bindTool = <I extends ToolInput, O extends ToolOutput>(
  definition: ToolDefinitionObject<I, O>,
  sandbox: LeasedSandbox,
  host: Host,
): Tool<I, O> => {
  const harness = createTestServices({
    bundle: { id: 'git' },
    provide: providers(sandbox, host),
  });

  return definition.bind(harness.services).toTool(
    harness.call({
      projectId: 'project-1',
      threadId: 'thread-1',
      promptId: 'prompt-1',
    }),
  );
};
