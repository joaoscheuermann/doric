import {
  bindRegistrant,
  type Call,
  type ContractTool,
  type Registrable,
  type Services,
} from 'bundle/contracts';
import type { ToolInput, ToolOutput, UnboundTool } from 'tool';

import {
  type BackgroundTerminal,
  type TerminalInput,
  type TerminalResult,
  TerminalV1,
} from '../contracts/index.js';
import { RuntimeWorkspaceV1 } from './peers.js';

/** What the `terminal` tool reaches, per call. Each method rejects with the provider's error unchanged. */
export interface TerminalToolPorts {
  /** The working directory of `call`'s prompt Thread (`runtime.workspace/v1.Cwd` under `call`). */
  cwd(call: Call): Promise<string>;
  /** terminal/v1 `run` for `call`'s prompt: its scope picks the Thread, its signal stops a foreground command. */
  run(
    input: TerminalInput,
    call: Call,
  ): Promise<TerminalResult | BackgroundTerminal>;
}

/** The ports over the kernel `Services`: today's `services.use(RuntimeWorkspaceV1 | TerminalV1, call.scope)`. Kernel-only. */
export const kernelTerminalToolPorts = (
  services: Services,
): TerminalToolPorts => ({
  cwd: (call) => services.use(RuntimeWorkspaceV1, call.scope).cwd(call),
  run: (input, call) => services.use(TerminalV1, call.scope).run(input, call),
});

/** `definition` bound to `kernelTerminalToolPorts` when the kernel registers it (S52's adapter). Kernel-only. */
export const kernelRegistrable = (
  definition: UnboundTool<ToolInput, ToolOutput, TerminalToolPorts>,
): Registrable<ContractTool> => ({
  [bindRegistrant]: (services) =>
    definition.bind(kernelTerminalToolPorts(services)),
});
