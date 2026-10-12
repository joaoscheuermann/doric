import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  BackgroundTerminal,
  Terminal,
  TerminalInput,
  TerminalResult,
} from '../src/contracts/index.js';

// The terminal control shapes the host declared before its types moved into
// the bundle contracts (`packages/host` at HEAD). They are copied here so the
// contract stays pinned to that baseline: a drift in `terminal/v1` fails
// compilation, not only a runtime check.
interface BaselineTerminalInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly background?: boolean;
  readonly pty?: boolean;
}

interface BaselineTerminalResult {
  readonly terminalId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly reason: 'exited' | 'timeout' | 'terminated' | 'failed';
}

interface BaselineTerminalControl {
  run(
    input: BaselineTerminalInput,
  ): Promise<
    | BaselineTerminalResult
    | { readonly terminalId: string; readonly background: true }
  >;
}

/** Exact type equality: drift from the baseline fails compilation. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when its type argument is `true`. */
const same = <T extends true>(): T => true as T;

type Run = Terminal['run'] extends (input: infer I, call?: infer _C) => infer R
  ? (input: I) => R
  : never;

const parity = {
  input: same<Equal<TerminalInput, BaselineTerminalInput>>(),
  result: same<Equal<TerminalResult, BaselineTerminalResult>>(),
  run: same<
    Equal<
      Awaited<ReturnType<Run>>,
      Awaited<ReturnType<BaselineTerminalControl['run']>>
    >
  >(),
  background:
    same<
      Equal<
        BackgroundTerminal,
        { readonly terminalId: string; readonly background: true }
      >
    >(),
} as const;

void test('terminal/v1 mirrors the host terminal control it replaced', () => {
  assert.deepEqual(
    Object.values(parity),
    Object.values(parity).map(() => true),
  );
});
