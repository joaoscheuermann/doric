// What `mcp`'s host logic calls outside itself (S59 D1): storage, secrets,
// the tool registry, the Project's sandbox lease and the log. The process
// binds them to its router clients.

import type { Call, Disposable, Log, Secrets, Storage } from 'bundle/contracts';
import type { AttachInput, Attachment, LeaseOutcome } from 'runtime/contracts';
import type { SandboxProcess, SandboxProcessInput } from 'sandbox';

import type { CallMcpTool, McpTool } from './tools.js';

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
