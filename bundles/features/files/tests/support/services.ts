import { createHash } from 'node:crypto';

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type RegisteredTool,
  type Services,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type Host,
  RuntimeAttachmentsV1,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
  runtimeAttachmentsMethods,
  runtimeLeaseMethods,
  runtimeWorkspaceMethods,
  sniffImageMediaType,
} from 'runtime/contracts';
import type { Sandbox } from 'sandbox';
import { type Terminal, TerminalV1, terminalMethods } from 'terminal/contracts';
import {
  isBoundTool,
  type Tool,
  type ToolDefinitionObject,
  type ToolInput,
  type ToolOutput,
} from 'tool';

import { activate } from '../../src/host/index.js';

/** The sandbox operations the fake lease forwards. */
export type LeasedSandbox = Pick<
  Sandbox,
  'id' | 'root' | 'exec' | 'readFile' | 'writeFile' | 'getFile'
>;

/** What the fake runtime.attachments/v1 kept, by attachment id. */
export type AttachedImages = Map<string, { name: string; bytes: string }>;

/**
 * Fake providers of the contracts this bundle requires, standing for the
 * prompt's lease and Thread exactly as the host adapter does: the lease
 * forwards to `sandbox`, the working directory to `host.workspace`, and, when
 * the facade carries terminals, `terminal/v1` to `host.terminals`.
 */
/**
 * runtime.attachments/v1 as the runtime answers it: an image keeps its
 * sha256 id, and bytes that are no image are refused.
 */
const attachments = (attached: AttachedImages) =>
  defineService(RuntimeAttachmentsV1, {
    attach: defineMethod({
      ...runtimeAttachmentsMethods.attach,
      execute: async ({ name, bytes }) => {
        const decoded = Buffer.from(bytes, 'base64');
        const mediaType = sniffImageMediaType(decoded);
        if (mediaType === undefined)
          throw new ContractError(
            'invalid_input',
            'The attachment is not a PNG, JPEG, WebP or GIF image.',
          );
        const id = `sha256-${createHash('sha256').update(decoded).digest('hex')}`;
        attached.set(id, { name, bytes });
        return { id, name, mediaType, size: decoded.length };
      },
    }),
    read: defineMethod({
      ...runtimeAttachmentsMethods.read,
      execute: async () => undefined,
    }),
  });

const providers = (
  sandbox: LeasedSandbox,
  host: Host,
  attached: AttachedImages = new Map(),
) => [
  attachments(attached),
  // By id: the stage-1 methods and location (1.2.0); withThread (1.1.0) has no
  // fake here.
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
    location: defineMethod({
      input: runtimeWorkspaceMethods.location.input,
      output: runtimeWorkspaceMethods.location.output,
      execute: () => host.workspace.location(),
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
    readFileBytes: defineMethod({
      input: runtimeLeaseMethods.readFileBytes.input,
      output: runtimeLeaseMethods.readFileBytes.output,
      execute: async (path) =>
        Buffer.from(await sandbox.getFile(path)).toString('base64'),
    }),
    writeFile: defineMethod({
      input: runtimeLeaseMethods.writeFile.input,
      output: runtimeLeaseMethods.writeFile.output,
      execute: async ([path, content]) => {
        await sandbox.writeFile(path, content);
      },
    }),
  }),
  ...(host.terminals === undefined
    ? []
    : [
        defineService(TerminalV1, {
          run: defineMethod({
            input: terminalMethods.run.input,
            output: terminalMethods.run.output,
            execute: (input) => (host.terminals as Terminal).run(input),
          }),
        }),
      ]),
];

export interface BoundServices {
  readonly services: Services;
  readonly call: Call;
  /** The terminal/v1 stub when the facade carries terminals. */
  readonly terminals: () => Terminal | undefined;
}

/** The `files` bundle's services over a fake lease and Thread. */
export const filesServices = (
  sandbox: LeasedSandbox,
  host: Host,
  attached?: AttachedImages,
): BoundServices => {
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: providers(sandbox, host, attached),
  });
  const terminal =
    host.terminals === undefined ? undefined : harness.services.use(TerminalV1);

  return {
    services: harness.services,
    call: harness.call({
      projectId: 'project-1',
      threadId: 'thread-1',
      promptId: 'prompt-1',
    }),
    terminals: () => terminal,
  };
};

/** The agent-loop tool of `definition` for one prompt over a fake lease and Thread. */
export const bindTool = <I extends ToolInput, O extends ToolOutput>(
  definition:
    | ToolDefinitionObject<I, O>
    | ((terminals: () => Terminal | undefined) => ToolDefinitionObject<I, O>),
  sandbox: LeasedSandbox,
  host: Host,
  attached?: AttachedImages,
): Tool<I, O> => {
  const { services, call, terminals } = filesServices(sandbox, host, attached);
  const resolved =
    typeof definition === 'function' ? definition(terminals) : definition;

  return resolved.bind(services).toTool(call);
};

/** A recording `tools/v1`, standing for the core's registry. */
const registry = (registered: Omit<RegisteredTool, 'bundleId'>[]) =>
  defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: ([tool, options]) => {
        registered.push({ tool, alwaysAvailable: options.alwaysAvailable });

        return { dispose: () => undefined };
      },
    }),
    list: defineMethod({
      input: toolsMethods.list.input,
      output: toolsMethods.list.output,
      execute: () => [],
    }),
    catalog: defineMethod({
      input: toolsMethods.catalog.input,
      output: toolsMethods.catalog.output,
      execute: async () => [],
    }),
  });

export interface ActivatedTool {
  readonly alwaysAvailable: boolean;
  readonly tool: Tool;
}

/**
 * Activates the bundle over the fake lease and Thread (with `terminal/v1`
 * when the facade carries terminals) and returns what it registered with
 * `tools/v1`, as the agent loop sees each tool for one prompt.
 */
export const activatedTools = async (
  sandbox: LeasedSandbox,
  host: Host,
): Promise<readonly ActivatedTool[]> => {
  const registered: Omit<RegisteredTool, 'bundleId'>[] = [];
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: [...providers(sandbox, host), registry(registered)],
  });

  await activate({ services: harness.services });

  const call = harness.call({
    projectId: 'project-1',
    threadId: 'thread-1',
    promptId: 'prompt-1',
  });

  return registered.map(({ tool, alwaysAvailable }) => {
    if (!isBoundTool(tool)) {
      throw new TypeError(`tools/v1 received an unbound tool: ${tool.name}`);
    }

    return { alwaysAvailable, tool: tool.toTool(call) };
  });
};
