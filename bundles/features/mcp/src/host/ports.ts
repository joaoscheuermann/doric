// What `mcp`'s host logic calls outside itself (S59 D1): storage, secrets,
// the tool registry, the Project's sandbox lease and the log. The kernel binds
// them to `services.use(...)` (`kernelMcpPorts`); the process binds them to
// its router clients.

import {
  type Call,
  type CallArg,
  type Disposable,
  type Log,
  LogV1,
  type Secrets,
  SecretsV1,
  type Services,
  type Storage,
  StorageV1,
  ToolsV1,
} from 'bundle/contracts';
import {
  type AttachInput,
  type Attachment,
  type LeaseOutcome,
  RuntimeLeaseV1,
} from 'runtime/contracts';
import type { SandboxProcess, SandboxProcessInput } from 'sandbox';

import { type CallMcpTool, type McpTool, toDoricTool } from './tools.js';

/** The `storage/v1` operations `ServerStore` uses. */
export type McpStorage = Pick<Storage, 'get' | 'query' | 'commit'>;

/**
 * The `secrets/v1` operations `mcp` uses, with today's `Secrets` shapes and errors (`credential_missing`,
 * `credential_name_taken`, …, as the provider's `ContractError`). `describe(ref, call)` runs under `call`; every
 * other method runs outside any caller's call (D2).
 */
export type McpSecrets = Pick<
  Secrets,
  'describe' | 'resolve' | 'create' | 'update' | 'delete' | 'list'
>;

/** One MCP tool to register: its Doric name, the server's tool, and how to call it on its server. */
export interface McpToolSource {
  readonly name: string;
  readonly tool: McpTool;
  readonly callTool: CallMcpTool;
}

/** A registered tool: `dispose()` ends the registration; it never throws (a failure to unregister is logged). */
export type McpToolRegistration = Disposable;

/** The `tools/v1` operations the manager uses. */
export interface McpTools {
  /**
   * Registers `source` as the tool `source.name` of `projectId` (`alwaysAvailable: false`, `order: 1000`). Resolves
   * with the registration once the registry accepted it. Rejects, registering nothing, with
   * `ToolErrorObject('invalid_schema')` when the server's input schema is not an object JSON Schema, or with the
   * registry's `ContractError` (`duplicate_tool`, `invalid_input`).
   */
  register(
    source: McpToolSource,
    projectId: string,
  ): Promise<McpToolRegistration>;
  /** The names `tools/v1` lists to a call scoped to `projectId` now. Rejects with the registry's error. */
  listed(projectId: string): Promise<ReadonlySet<string>>;
}

/** The sandbox an `McpLease` task runs on: `start` absent when it cannot keep a process running. */
export interface McpSandbox {
  /**
   * Starts a live process; resolves once it started. Rejects with the lease failure (then the run's outcome is that
   * status), `ContractError('unsupported_operation')` when the sandbox cannot keep a process, or the sandbox's error.
   */
  start?(input: SandboxProcessInput): Promise<SandboxProcess>;
}

/** Runs tasks on a Project's current sandbox, never acquiring one. */
export interface McpLease {
  /**
   * Runs `task` on the sandbox `projectId` holds now, outside any caller's call (D2). Answers `{status: 'ready', value}`,
   * or `{status}` (`pending`, `unavailable`, `expired`, `missing`) when the lease could not run it. Rejects with any
   * other failure. A process `task` started keeps running after the run ended.
   */
  run<T>(
    projectId: string,
    task: (sandbox: McpSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>>;
}

/** Keeps a tool result's image for the call's Thread (`runtime.attachments/v1.attach`), under `call`. */
export type McpAttach = (input: AttachInput, call: Call) => Promise<Attachment>;

/** What `mcp`'s host logic calls outside itself. */
export interface McpPorts {
  readonly storage: McpStorage;
  readonly secrets: McpSecrets;
  readonly tools: McpTools;
  readonly lease: McpLease;
  readonly log: () => Log;
}

/**
 * The kernel's ports, each today's `services.use(...)` call made when it runs: `storage` = `use(StorageV1)`,
 * `secrets` = `use(SecretsV1)`, `tools.register` = `use(ToolsV1).register(toDoricTool(source), {alwaysAvailable:
 * false, order: 1000, projectId})` (its synchronous throw as the rejection), `tools.listed` = `use(ToolsV1,
 * {projectId}).catalog()` names, `lease.run` = `use(RuntimeLeaseV1, {projectId}).withLease`, `log` = `use(LogV1)`.
 * Kernel only; leaves in group F.
 */
export const kernelMcpPorts = (services: Services): McpPorts => {
  const storage = () => services.use(StorageV1);
  const secrets = () => services.use(SecretsV1);

  return {
    storage: {
      get: (...args) => storage().get(...args),
      query: (...args) => storage().query(...args),
      commit: (...args) => storage().commit(...args),
    },
    secrets: {
      describe: (...args) => secrets().describe(...args),
      resolve: (...args) => secrets().resolve(...args),
      create: (...args) => secrets().create(...args),
      update: (...args) => secrets().update(...args),
      delete: (...args) => secrets().delete(...args),
      list: (...args) => secrets().list(...args),
    },
    tools: {
      register: async (source, projectId) =>
        services.use(ToolsV1).register(toDoricTool(source), {
          alwaysAvailable: false,
          order: TOOL_ORDER,
          projectId,
        }),
      listed: async (projectId) => {
        const entries = await services.use(ToolsV1, { projectId }).catalog();

        return new Set(entries.map(({ name }) => name));
      },
    },
    lease: {
      run: async (projectId, task) =>
        services.use(RuntimeLeaseV1, { projectId }).withLease(task),
    },
    log: () => services.use(LogV1),
  };
};

/** After every built-in tool (the last one is `git`, at 900). */
const TOOL_ORDER = 1000;

/** `CallArg` re-exported for the ports' callers. */
export type { CallArg };
