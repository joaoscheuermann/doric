// The core's client hooks/v1 runs the window hooks of this window when main
// closes it: onCloseHook may veto, onFlushHook runs in the flush phase.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { HooksV1, WindowHooksV1 } from 'bundle/contracts';

import { openWindow, probe, type TestWindow } from './support/window.js';

let opened: TestWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const closing = (log: string[], veto: boolean) =>
  probe(
    'x',
    (services) => {
      const hooks = services.use(HooksV1).use(WindowHooksV1);

      hooks.onCloseHook(() => {
        log.push('close');

        return veto ? { allow: false, reason: 'unsaved' } : { allow: true };
      });
      hooks.onFlushHook(() => {
        log.push('flush');
      });
    },
    ['hooks/v1@^1.0.0'],
  );

void test('close runs onCloseHook, then the flush phase runs onFlushHook', async () => {
  const log: string[] = [];

  opened = await openWindow({ probes: [closing(log, false)] });

  assert.deepEqual(
    await opened.requestClose({ phase: 'close', forced: false, deadline: 0 }),
    { allow: true },
  );
  await opened.requestClose({
    phase: 'flush',
    forced: false,
    deadline: Date.now() + 1_500,
  });
  assert.deepEqual(log, ['close', 'flush']);
});

void test('a veto keeps the window', async () => {
  const log: string[] = [];

  opened = await openWindow({ probes: [closing(log, true)] });

  const answer = await opened.requestClose({
    phase: 'close',
    forced: false,
    deadline: 0,
  });

  assert.equal(answer?.allow, false);
  assert.deepEqual(log, ['close']);
});
