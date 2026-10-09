import assert from 'node:assert/strict';
import test from 'node:test';

import type * as host from 'host';

import type {
  BackgroundTerminal,
  Terminal,
  TerminalInput,
  TerminalResult,
} from '../src/contracts/index.js';

/** Exact type equality: drift from packages/host fails this compilation. */
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
  input: same<Equal<TerminalInput, host.TerminalInput>>(),
  result: same<Equal<TerminalResult, host.TerminalResult>>(),
  run: same<
    Equal<
      Awaited<ReturnType<Run>>,
      Awaited<ReturnType<host.TerminalControl['run']>>
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

void test('terminal/v1 mirrors packages/host TerminalControl', () => {
  assert.deepEqual(
    Object.values(parity),
    Object.values(parity).map(() => true),
  );
});
