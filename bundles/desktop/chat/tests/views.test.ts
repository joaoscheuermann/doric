// `chat.views/v1` (§7.7, D9-16): renderer specs are strict and need a defined
// element; one projector owns an event type, and the built-in projection owns
// every type that is not a versioned bundle event; external blocks replay in
// sequence order; a versioned type nobody claims becomes a generic block,
// while today's unversioned types stay the built-in projection's.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import {
  builtInClaims,
  externalBlocks,
  GENERIC_BLOCK_TYPE,
  reuseBlocks,
} from '../src/client/domain/external-blocks.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';
import {
  builtInAliases,
  createChatViews,
  GENERIC_BLOCK_TAG,
} from '../src/client/services/views.js';
import {
  type ChatBlock,
  ChatViewsV1,
  type ProjectorSpec,
} from '../src/contracts/index.js';

const conflict = (error: unknown) =>
  isContractError(error) && error.code === 'registration_conflict';

const event = (
  sequence: number,
  type: string,
  payload: unknown = {},
): ThreadEvent => ({
  projectId: 'p',
  threadId: 't',
  promptId: `prompt-${sequence}`,
  sequence,
  type,
  event: payload,
  createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
});

/** Counts its events and draws one block per event with the running count. */
const counter = (type: string): ProjectorSpec<number> => ({
  eventTypes: [type],
  initial: () => 0,
  reduce: (count, entry) => ({
    state: count + 1,
    blocks: [
      {
        id: `${type}:${entry.sequence}`,
        type: `${type}.block`,
        promptId: entry.promptId,
        sequence: entry.sequence,
        data: count + 1,
      },
    ],
  }),
});

const setup = (defined: readonly string[] = ['x-card']) => {
  const views = createChatViews({ isDefined: (tag) => defined.includes(tag) });
  const services = createTestServices({
    bundle: { id: 'extension' },
    provide: [views.service],
  });
  return {
    registry: views.registry,
    api: services.services.use(ChatViewsV1),
    dispose: services.dispose,
  };
};

describe('chat.views/v1', () => {
  test('a renderer draws its block type; other block types fall back to chat-block', async () => {
    const { registry, api, dispose } = setup();
    const renderer = api.registerRenderer({
      blockType: 'x.card',
      elementTag: 'x-card',
    });

    assert.equal(registry.rendererFor('x.card'), 'x-card');
    assert.equal(registry.rendererFor('y.card'), GENERIC_BLOCK_TAG);
    renderer.dispose();
    assert.equal(registry.rendererFor('x.card'), GENERIC_BLOCK_TAG);
    await dispose();
  });

  test('a renderer spec is strict, needs a defined element and one owner per block type', async () => {
    const { api, dispose } = setup();
    assert.throws(
      () =>
        api.registerRenderer({
          blockType: 'x.card',
          elementTag: 'x-card',
          extra: true,
        } as never),
      (error) => isContractError(error) && error.code === 'invalid_input',
    );
    assert.throws(
      () =>
        api.registerRenderer({ blockType: 'x.card', elementTag: 'x-missing' }),
      (error) => isContractError(error) && error.code === 'invalid_input',
    );
    api.registerRenderer({ blockType: 'x.card', elementTag: 'x-card' });
    assert.throws(
      () => api.registerRenderer({ blockType: 'x.card', elementTag: 'x-card' }),
      conflict,
    );
    await dispose();
  });

  test('one projector owns an event type; the built-in projection owns unversioned and aliased types', async () => {
    const { registry, api, dispose } = setup();
    const first = api.registerProjector(counter('x.thing/v1'));

    assert.throws(() => api.registerProjector(counter('x.thing/v1')), conflict);
    assert.throws(
      () => api.registerProjector(counter('tool.finished')),
      conflict,
    );
    assert.throws(
      () => api.registerProjector(counter('runtime.prompt-finished/v1')),
      conflict,
    );
    assert.equal(registry.projectors().length, 1);

    first.dispose();
    api.registerProjector(counter('x.thing/v1'));
    assert.equal(registry.projectors().length, 1);
    await dispose();
  });

  test('external projectors replay the whole list in sequence order, the same on every replay', () => {
    const events = [
      event(1, 'agent.text'),
      event(2, 'y.other/v1'),
      event(3, 'x.thing/v1'),
      event(4, 'x.thing/v1'),
    ];
    const projectors = [counter('y.other/v1'), counter('x.thing/v1')];

    const blocks = externalBlocks(events, projectors, builtInAliases);
    const replay = externalBlocks(events, projectors, builtInAliases);

    assert.deepEqual(
      blocks.map((block: ChatBlock) => [
        block.sequence,
        block.type,
        block.data,
      ]),
      [
        [2, 'y.other/v1.block', 1],
        [3, 'x.thing/v1.block', 1],
        [4, 'x.thing/v1.block', 2],
      ],
    );
    assert.deepEqual(replay, blocks);
  });

  test('a replay that reads the same keeps the blocks it read before', () => {
    const events = [
      event(2, 'y.other/v1'),
      event(3, 'x.thing/v1', { note: ['a', { deep: 1 }] }),
    ];
    const projectors = [counter('y.other/v1'), counter('x.thing/v1')];
    const first = externalBlocks(events, projectors, builtInAliases);

    // The same log read again: the same list, the same blocks.
    const again = reuseBlocks(
      first,
      externalBlocks(events, projectors, builtInAliases),
    );
    assert.equal(again, first);

    // One more event: the blocks read before stand, the new one is new.
    const grown = reuseBlocks(
      first,
      externalBlocks(
        [...events, event(4, 'x.thing/v1')],
        projectors,
        builtInAliases,
      ),
    );
    assert.notEqual(grown, first);
    assert.equal(grown[0], first[0]);
    assert.equal(grown[1], first[1]);
    assert.equal(grown[2]?.id, 'x.thing/v1:4');

    // A block whose data changed under the same id is a new block.
    const changed = reuseBlocks(first, [
      first[0] as ChatBlock,
      { ...(first[1] as ChatBlock), data: 2 },
    ]);
    assert.equal(changed[0], first[0]);
    assert.notEqual(changed[1], first[1]);
    assert.equal(changed[1]?.data, 2);

    // Fewer blocks than before is a new list, however the kept ones read.
    assert.notEqual(reuseBlocks(first, [first[0] as ChatBlock]), first);
  });

  test('a versioned type nobody claims is one generic block; built-in types add none', () => {
    const blocks = externalBlocks(
      [
        event(1, 'queue.paused'),
        event(2, 'response.started'),
        event(3, 'prompt.finished'),
        event(4, 'runtime.prompt-finished/v1'),
        event(5, 'x.unknown/v2', { value: 7 }),
      ],
      [],
      builtInAliases,
    );

    assert.deepEqual(blocks, [
      {
        id: 'event:5',
        type: GENERIC_BLOCK_TYPE,
        promptId: 'prompt-5',
        sequence: 5,
        data: {
          eventType: 'x.unknown/v2',
          createdAt: '2026-01-01T00:00:05.000Z',
          payload: { value: 7 },
        },
      },
    ]);
  });

  test('a projector that throws adds nothing for that event and keeps its state', () => {
    const failures: unknown[] = [];
    const flaky: ProjectorSpec<number> = {
      ...counter('x.thing/v1'),
      reduce: (count, entry) => {
        if (entry.sequence === 2) throw new Error('bad event');
        return counter('x.thing/v1').reduce(count, entry);
      },
    };
    const blocks = externalBlocks(
      [event(1, 'x.thing/v1'), event(2, 'x.thing/v1'), event(3, 'x.thing/v1')],
      [flaky],
      builtInAliases,
      (error) => failures.push(error),
    );

    assert.deepEqual(
      blocks.map((block) => [block.sequence, block.data]),
      [
        [1, 1],
        [3, 2],
      ],
    );
    assert.equal(failures.length, 1);
  });

  test('the built-in claim is exactly unversioned types plus the runtime aliases', () => {
    assert.equal(builtInClaims('tool.finished', builtInAliases), true);
    assert.equal(builtInClaims('usage', builtInAliases), true);
    assert.equal(
      builtInClaims('runtime.prompt-finished/v1', builtInAliases),
      true,
    );
    assert.equal(builtInClaims('git.commit/v1', builtInAliases), false);
  });
});
