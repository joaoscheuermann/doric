import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/*
 * terminal/v1: tracked terminal commands of the calling prompt's Thread
 * (call.scope), derived one to one from packages/host's TerminalControl. In
 * stage 1 the provisional host adapter in agents/doric provides it; stage 10
 * moves it into the `terminal` bundle without changing this import path.
 */

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

export interface BackgroundTerminal {
  readonly terminalId: string;
  readonly background: true;
}

export const terminalInputSchema = z
  .object({
    command: z.string(),
    cwd: z.string(),
    timeoutMs: z.number(),
    background: z.boolean().optional(),
    pty: z.boolean().optional(),
  })
  .strict();

export const terminalResultSchema: z.ZodType<TerminalResult, TerminalResult> =
  z.looseObject({
    terminalId: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    durationMs: z.number(),
    reason: z.enum(['exited', 'timeout', 'terminated', 'failed']),
  });

export const backgroundTerminalSchema: z.ZodType<
  BackgroundTerminal,
  BackgroundTerminal
> = z.looseObject({
  terminalId: z.string(),
  background: z.literal(true),
});

export interface Terminal {
  /**
   * Runs one command. A foreground command resolves with its result; a
   * background one resolves at once with its terminal ID.
   */
  run(
    input: TerminalInput,
    call?: CallArg,
  ): Promise<TerminalResult | BackgroundTerminal>;
}

export const terminalMethods = {
  run: {
    input: terminalInputSchema,
    output: z.union([backgroundTerminalSchema, terminalResultSchema]),
  },
} as const;

export const TerminalV1 = ref<Terminal>('terminal/v1');
