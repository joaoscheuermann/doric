import assert from 'node:assert/strict';
import test from 'node:test';

import { terminalMethods } from 'terminal/contracts';
import type { z } from 'zod';

import {
  runtimeLeaseMethods,
  runtimeThreadsMethods,
  runtimeWorkspaceMethods,
} from '../src/contracts/index.js';
import { readTranscript, recordTranscript } from './support/capture-adapter.js';

/*
 * The golden transcripts of the stage-1 host-adapter (57-WP-0) are the
 * oracle 57-WP-R2 replays against the runtime providers. These cases check
 * that the recording covers what the design names and that the extended
 * contracts still accept every answer the adapter gave.
 */

const stageOne: Record<
  string,
  Record<string, { readonly output: z.ZodType }>
> = {
  'runtime.threads/v1': {
    spawn: runtimeThreadsMethods.spawn,
    list: runtimeThreadsMethods.list,
    get: runtimeThreadsMethods.get,
    events: runtimeThreadsMethods.events,
    send: runtimeThreadsMethods.send,
    interrupt: runtimeThreadsMethods.interrupt,
    terminate: runtimeThreadsMethods.terminate,
  },
  'runtime.workspace/v1': runtimeWorkspaceMethods,
  'runtime.lease/v1': {
    describe: runtimeLeaseMethods.describe,
    exec: runtimeLeaseMethods.exec,
    readFile: runtimeLeaseMethods.readFile,
    writeFile: runtimeLeaseMethods.writeFile,
  },
  'terminal/v1': terminalMethods,
};

const inactive = 'Thread control is no longer active.';

void test('the transcript calls every stage-1 method of the four contracts', async () => {
  const { steps } = await readTranscript();

  for (const [contract, methods] of Object.entries(stageOne))
    for (const method of Object.keys(methods))
      assert.ok(
        steps.some(
          (step) => step.contract === contract && step.method === method,
        ),
        `${contract}.${method} is not recorded`,
      );
});

void test('after the prompt ended every contract refuses with the inactive error', async () => {
  const { steps } = await readTranscript();
  const ended = steps.filter(({ phase }) => phase === 'ended');

  assert.deepEqual(
    [...new Set(ended.map(({ contract }) => contract))].sort(),
    Object.keys(stageOne).sort(),
  );

  for (const step of ended)
    assert.deepEqual(step.outcome, {
      error: { name: 'Error', message: inactive },
    });
});

void test('a facade without terminals answers the unavailable refusal', async () => {
  const { steps } = await readTranscript();

  assert.deepEqual(
    steps.filter(({ phase }) => phase === 'no-terminals'),
    [
      {
        label: 'terminal run on a facade without terminals',
        phase: 'no-terminals',
        contract: 'terminal/v1',
        method: 'run',
        args: [{ command: 'ls', cwd: '/workspace', timeoutMs: 1000 }],
        outcome: {
          error: {
            name: 'ContractError',
            message: 'This prompt has no live terminals.',
            code: 'unavailable',
          },
        },
      },
    ],
  );
});

void test('every recorded answer satisfies the extended contract schemas', async () => {
  const { steps } = await readTranscript();

  for (const step of steps) {
    if (!('value' in step.outcome)) continue;

    const spec = stageOne[step.contract]?.[step.method];

    assert.ok(spec !== undefined, `${step.contract}.${step.method}`);
    assert.deepEqual(
      spec.output.parse(step.outcome.value),
      step.outcome.value,
      step.label,
    );
  }
});

const live =
  process.env.DORIC_TEST_DATABASE_URL !== undefined &&
  process.env.DORIC_TEST_ADAPTER_CAPTURE === 'true';

void test('a fresh recording from the kernel adapter equals the fixture', {
  skip: live
    ? false
    : 'Requires DORIC_TEST_DATABASE_URL, DORIC_TEST_ADAPTER_CAPTURE=true and the agents/doric test build',
  timeout: 60_000,
}, async () => {
  const recorded = await recordTranscript(
    process.env.DORIC_TEST_DATABASE_URL as string,
  );

  assert.deepEqual(recorded, await readTranscript());
});
