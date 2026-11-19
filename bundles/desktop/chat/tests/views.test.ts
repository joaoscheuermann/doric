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

describe('chat.views/v1 fence renderers (openui.md D1, B3)', () => {
  const invalid = (error: unknown) =>
    isContractError(error) && error.code === 'invalid_input';

  test('a second fence renderer of one tag is registration_conflict, until the first is disposed', async () => {
    const { api, dispose } = setup(['x-fence', 'y-fence']);
    const first = api.registerFenceRenderer({
      tag: 'openui-lang',
      elementTag: 'x-fence',
    });
    assert.throws(
      () =>
        api.registerFenceRenderer({
          tag: 'openui-lang',
          elementTag: 'y-fence',
        }),
      conflict,
    );
    // Another tag is free.
    api.registerFenceRenderer({ tag: 'papercraft', elementTag: 'y-fence' });

    first.dispose();
    api.registerFenceRenderer({ tag: 'openui-lang', elementTag: 'y-fence' });
    await dispose();
  });

  test('an element ui/v1 has not defined, and a tag holding a space, are invalid_input', async () => {
    const { api, dispose } = setup(['x-fence']);
    assert.throws(
      () =>
        api.registerFenceRenderer({
          tag: 'openui-lang',
          elementTag: 'x-missing',
        }),
      invalid,
    );
    assert.throws(
      () =>
        api.registerFenceRenderer({
          tag: 'openui lang',
          elementTag: 'x-fence',
        }),
      invalid,
    );
    // Neither left a registration behind.
    api.registerFenceRenderer({ tag: 'openui-lang', elementTag: 'x-fence' });
    await dispose();
  });

  test('a watchFences input with an empty threadId is invalid_input', async () => {
    const { api, dispose } = setup();
    assert.throws(
      () =>
        api.watchFences(
          { projectId: 'p', threadId: '', tag: 'openui-lang' },
          () => undefined,
        ),
      invalid,
    );
    await dispose();
  });
});

describe('chat.views/v1 tool and input renderers (1.2.0)', () => {
  const invalid = (error: unknown) =>
    isContractError(error) && error.code === 'invalid_input';
  /** `registration_conflict` naming the bundle that holds the registration. */
  const conflictWith = (owner: string) => (error: unknown) =>
    conflict(error) && (error as Error).message.includes(owner);

  test('T5.1: a second tool renderer of one name is registration_conflict naming the owner, until the first is disposed', async () => {
    const { registry, api, dispose } = setup(['x-tool', 'y-tool']);
    const first = api.registerToolRenderer({
      toolName: 'probe_tool',
      elementTag: 'x-tool',
    });
    assert.throws(
      () =>
        api.registerToolRenderer({
          toolName: 'probe_tool',
          elementTag: 'y-tool',
        }),
      conflictWith('extension'),
    );
    // The first registration still holds the name.
    assert.equal(
      registry.toolRenderers().get('probe_tool')?.elementTag,
      'x-tool',
    );
    // Another name is free.
    api.registerToolRenderer({ toolName: 'other_tool', standalone: true });

    first.dispose();
    assert.equal(registry.toolRenderers().has('probe_tool'), false);
    api.registerToolRenderer({ toolName: 'probe_tool', elementTag: 'y-tool' });
    assert.equal(
      registry.toolRenderers().get('probe_tool')?.elementTag,
      'y-tool',
    );
    await dispose();
  });

  test('T5.1: a tool spec with an empty name, an unknown key, a non-boolean flag or an undefined element is invalid_input and registers nothing', async () => {
    const { registry, api, dispose } = setup(['x-tool']);
    const specs = [
      { toolName: '', elementTag: 'x-tool' },
      { toolName: 'probe_tool', elementTag: 'x-tool', extra: true },
      { toolName: 'probe_tool', standalone: 'yes' },
      { toolName: 'probe_tool', openByDefault: 1 },
      { toolName: 'probe_tool', elementTag: 'x-missing' },
    ];
    for (const spec of specs) {
      assert.throws(
        () => api.registerToolRenderer(spec as never),
        invalid,
        JSON.stringify(spec),
      );
    }
    assert.equal(registry.toolRenderers().size, 0);
    // None left a registration behind.
    api.registerToolRenderer({ toolName: 'probe_tool', elementTag: 'x-tool' });
    await dispose();
  });

  test('T5.1: a tool spec with no element registers, with its flags', async () => {
    const { registry, api, dispose } = setup([]);
    api.registerToolRenderer({ toolName: 'probe_view', openByDefault: true });
    const registered = registry.toolRenderers().get('probe_view');
    assert.equal(registered?.elementTag, undefined);
    assert.equal(registered?.openByDefault, true);
    await dispose();
  });

  test('T5.2: an input renderer of the source user, a bare bundle, bundle: or an undefined element is invalid_input', async () => {
    const { registry, api, dispose } = setup(['x-input']);
    const specs = [
      { source: 'user', elementTag: 'x-input' },
      { source: 'bundle', elementTag: 'x-input' },
      { source: 'bundle:', elementTag: 'x-input' },
      { source: 'terminal', elementTag: 'x-missing' },
      { source: 'terminal', elementTag: '' },
      { source: 'terminal', elementTag: 'x-input', extra: true },
    ];
    for (const spec of specs) {
      assert.throws(
        () => api.registerInputRenderer(spec as never),
        invalid,
        JSON.stringify(spec),
      );
    }
    assert.equal(registry.inputRenderers().size, 0);
    await dispose();
  });

  test('T5.2: an input renderer registers under its source, and a second of one source is registration_conflict naming the owner', async () => {
    const { registry, api, dispose } = setup(['x-input', 'y-input']);
    const first = api.registerInputRenderer({
      source: 'terminal',
      elementTag: 'x-input',
    });
    api.registerInputRenderer({
      source: 'bundle:probe',
      elementTag: 'y-input',
    });
    assert.equal(registry.inputRenderers().get('terminal'), 'x-input');
    assert.equal(registry.inputRenderers().get('bundle:probe'), 'y-input');
    assert.throws(
      () =>
        api.registerInputRenderer({
          source: 'terminal',
          elementTag: 'y-input',
        }),
      conflictWith('extension'),
    );
    first.dispose();
    assert.equal(registry.inputRenderers().has('terminal'), false);
    api.registerInputRenderer({ source: 'terminal', elementTag: 'y-input' });
    assert.equal(registry.inputRenderers().get('terminal'), 'y-input');
    await dispose();
  });

  test('disposing a tool or input renderer twice is harmless', async () => {
    const { registry, api, dispose } = setup(['x-tool', 'x-input']);
    const tool = api.registerToolRenderer({
      toolName: 'probe_tool',
      elementTag: 'x-tool',
    });
    const input = api.registerInputRenderer({
      source: 'terminal',
      elementTag: 'x-input',
    });
    tool.dispose();
    input.dispose();
    // A later registration of the same keys is not undone by a second dispose.
    api.registerToolRenderer({ toolName: 'probe_tool', elementTag: 'x-tool' });
    api.registerInputRenderer({ source: 'terminal', elementTag: 'x-input' });
    tool.dispose();
    input.dispose();
    assert.equal(registry.toolRenderers().has('probe_tool'), true);
    assert.equal(registry.inputRenderers().has('terminal'), true);
    await dispose();
  });

  test('toolRenderers() and inputRenderers() answer a new map per change and the same map between changes, and notify subscribers', async () => {
    const { registry, api, dispose } = setup(['x-tool', 'x-input']);
    let notified = 0;
    const stop = registry.subscribe(() => {
      notified += 1;
    });
    const tools0 = registry.toolRenderers();
    const inputs0 = registry.inputRenderers();
    assert.equal(registry.toolRenderers(), tools0);
    assert.equal(registry.inputRenderers(), inputs0);

    const tool = api.registerToolRenderer({
      toolName: 'probe_tool',
      elementTag: 'x-tool',
    });
    const tools1 = registry.toolRenderers();
    assert.notEqual(tools1, tools0);
    assert.equal(registry.toolRenderers(), tools1);
    assert.ok(notified > 0, 'no notification on a tool registration');
    let seen = notified;

    const input = api.registerInputRenderer({
      source: 'terminal',
      elementTag: 'x-input',
    });
    const inputs1 = registry.inputRenderers();
    assert.notEqual(inputs1, inputs0);
    assert.equal(registry.inputRenderers(), inputs1);
    assert.ok(notified > seen, 'no notification on an input registration');
    seen = notified;

    tool.dispose();
    assert.notEqual(registry.toolRenderers(), tools1);
    assert.ok(notified > seen, 'no notification on a tool removal');
    seen = notified;
    input.dispose();
    assert.notEqual(registry.inputRenderers(), inputs1);
    assert.ok(notified > seen, 'no notification on an input removal');
    stop();
    await dispose();
  });
});
