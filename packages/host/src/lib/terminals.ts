/** A command registered with its owning Thread for its entire lifetime. */
export interface TerminalInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly background?: boolean;
  readonly pty?: boolean;
}
export interface TerminalResult {
  readonly terminalId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly reason: 'exited' | 'timeout' | 'terminated' | 'failed';
}
export interface TerminalControl {
  run(
    input: TerminalInput,
  ): Promise<
    TerminalResult | { readonly terminalId: string; readonly background: true }
  >;
}
