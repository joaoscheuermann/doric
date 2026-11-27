import type { Call } from 'bundle/contracts';

import type {
  BackgroundTerminal,
  TerminalInput,
  TerminalResult,
} from '../contracts/index.js';

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
