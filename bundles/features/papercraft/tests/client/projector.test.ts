// PC19 (papercraft-openui.md D10): the `papercraft.cwd/v1` events papercraft's
// host appends to a Thread's log are the Thread's working directory, not
// something the conversation shows. papercraft's client claims them with a
// projector that gives no block, so chat never draws them as a generic block.
//
// PC21 (D25): stage 4 removes the artifacts bundle, but old Threads still hold
// its `artifacts.*` rows. papercraft claims each of them with a projector
// that gives no block, so they replay as nothing instead of a generic block.

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

test('PC19: a papercraft.cwd/v1 event gives no block', async () => {
  const host = await startHost();

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

const artifactId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf16b1';

/** One old `artifacts.*` row as the store still holds it. */
const artifactEvent = (
  type: string,
  sequence: number,
  payload: Record<string, unknown>,
): ChatThreadEvent => ({
  projectId: 'p1',
  threadId: 't1',
  promptId: 'p-1',
  sequence,
  type,
  event: { type, ...payload },
  createdAt: '2026-11-06T12:00:00Z',
});

for (const [type, payload] of [
  [
    'artifacts.created/v1',
    { artifactId, kind: 'papercraft-preview', title: 'Card', revision: 1 },
  ],
  ['artifacts.revised/v1', { artifactId, revision: 2 }],
  ['artifacts.applied/v1', { artifactId, revision: 2 }],
  ['artifacts.approved/v1', { artifactId, revision: 2 }],
] as const) {
  test(`PC21: exactly one projector claims ${type} and its row gives no block`, async () => {
    const host = await startHost();

    const claiming = host
      .projectors()
      .filter((spec) => spec.eventTypes.includes(type));

    assert.equal(claiming.length, 1, `one projector claims ${type}`);

    const [projector] = claiming;
    assert.ok(projector !== undefined);

    const step = projector.reduce(
      projector.initial(),
      artifactEvent(type, 7, payload),
    );
    assert.deepEqual(step.blocks, []);

    await host.dispose();
  });
}
