// PC19 (papercraft-openui.md D10): the `papercraft.cwd/v1` events papercraft's
// host appends to a Thread's log are the Thread's working directory, not
// something the conversation shows. papercraft's client claims them with a
// projector that gives no block, whether the Generative UI setting is on or
// off, so chat never draws them as a generic block.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { ChatThreadEvent } from '../../src/contracts/chat.js';
import { closeWindow } from './support/dom.js';
import { startHost } from './support/fence-host.js';

after(closeWindow);

const cwdEvent = (sequence: number, cwd: string): ChatThreadEvent => ({
  projectId: 'p1',
  threadId: 't1',
  promptId: 'p-1',
  sequence,
  type: 'papercraft.cwd/v1',
  event: { cwd },
  createdAt: '2026-11-06T12:00:00Z',
});

for (const setting of [true, false]) {
  test(`PC19: a papercraft.cwd/v1 event gives no block, with the setting ${setting ? 'on' : 'off'}`, async () => {
    const host = await startHost({ setting });

    const claiming = host
      .projectors()
      .filter((spec) => spec.eventTypes.includes('papercraft.cwd/v1'));

    assert.equal(
      claiming.length,
      1,
      'papercraft claims papercraft.cwd/v1 with one projector',
    );

    const [projector] = claiming;
    assert.ok(projector !== undefined);

    let state = projector.initial();
    for (const [sequence, cwd] of [
      [4, '/workspace/app'],
      [9, '/workspace/app/packages/ui'],
    ] as const) {
      const step = projector.reduce(state, cwdEvent(sequence, cwd));
      assert.deepEqual(step.blocks, [], `the event at ${String(sequence)}`);
      state = step.state;
    }

    await host.dispose();
  });
}
