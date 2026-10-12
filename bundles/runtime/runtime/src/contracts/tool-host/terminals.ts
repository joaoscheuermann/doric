import type {
  BackgroundTerminal,
  TerminalInput,
  TerminalResult,
} from 'terminal/contracts';

/** The tracked-command capability of `host.terminals`, the `terminal/v1` shape. */
export interface TerminalControl {
  run(input: TerminalInput): Promise<TerminalResult | BackgroundTerminal>;
}
