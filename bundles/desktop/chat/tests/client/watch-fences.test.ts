// `chat.views/v1.watchFences` (openui.md D1, B3) in a real window: a surface
// outside the conversation reads a Thread's fences of one tag, computed by the
// conversation's own projection, over a watch of its own.
//
// Contract matrix:
// - the listener gets the whole list, and again after each flush that changes
//   it (by key, state or body), never twice the same list in a row;
// - an unknown Thread gives `[]` once;
// - a tag with no fence renderer gives `[]`, then the list once one registers;
// - a `deleted` update gives `[]` and ends the watch's stream;
// - the window's conversation opening 21 other Threads leaves the watch live;
// - two subscriptions of one Thread share one stream, released with the last.
// (The DOM-free checks of the method's input are in `tests/views.test.ts`.)

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { Disposable } from 'bundle/contracts';

import type { ChatFence, ChatViews } from '../../src/contracts/index.js';
import {
  answering,
  assertReady,
  fenceProbe,
  otherThreadId,
  projectId,
  push,
  snapshot,
  streamOf,
  threadEvent,
  threadId,
  threadPath,
  threadRecord,
  threadUrl,
} from './support/fences.js';
import {
  type ChatWindow,
  openChatWindow,
  type Probe,
  settle,
} from './support/window.js';

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const unknownThreadId = '66666666-6666-4666-8666-666666666666';
/** Other Threads of the Project the conversation can be shown on. */
const visited = Array.from(
  { length: 21 },
  (_, at) => `77777777-7777-4777-8777-${String(at).padStart(12, '0')}`,
);

const open = async (probe: Probe): Promise<ChatWindow> => {
  opened = await openChatWindow({
    url: threadUrl(threadId),
    host: {
      'runtime.threads/v1.thread': (input: unknown) => {
        const id = Array.isArray(input) ? String(input[0]) : threadId;
        return id === unknownThreadId ? undefined : threadRecord(id);
      },
      'runtime.threads/v1.queue': () => ({
        revision: 1,
        paused: false,
        stopping: false,
        items: [],
      }),
    },
    probe,
  });
  await settle(50);
  return opened;
};

/** Watches `thread`'s fences of `tag`, writing down each list it is given. */
const watch = (
  views: ChatViews | undefined,
  thread = otherThreadId,
  tag = 'probe-ui',
): { lists: (readonly ChatFence[])[]; subscription: Disposable } => {
  const lists: (readonly ChatFence[])[] = [];
  assert.ok(views, 'the probe is active');
  const subscription = views.watchFences(
    { projectId, threadId: thread, tag },
    (fences) => {
      lists.push(fences);
    },
  );
  return { lists, subscription };
};

const brief = (fences: readonly ChatFence[] | undefined) =>
  fences?.map((fence) => [fence.key, fence.state, fence.body]);

const closed = (body: string) => `\`\`\`probe-ui\n${body}\n\`\`\``;

describe('chat.views/v1.watchFences', () => {
  test('gives the list, then again only after a flush that changes it', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await open(probe);
    const { lists } = watch(state.views);
    await settle(50);
    snapshot(
      window,
      answering(closed('a = 1'), 'p1', otherThreadId),
      otherThreadId,
    );
    await settle(150);

    assert.deepEqual(brief(lists.at(-1)), [['p1/4/0', 'closed', 'a = 1']]);
    const settled = lists.length;

    // Prose alone changes no fence.
    push(
      window,
      threadEvent(
        5,
        { type: 'text.delta', delta: '\n\nThat is all.' },
        'p1',
        otherThreadId,
      ),
      otherThreadId,
    );
    await settle(150);
    assert.equal(lists.length, settled);

    push(
      window,
      threadEvent(
        6,
        { type: 'text.delta', delta: `\n\n${closed('b = 2')}` },
        'p1',
        otherThreadId,
      ),
      otherThreadId,
    );
    await settle(150);
    assert.equal(lists.length, settled + 1);
    assert.deepEqual(brief(lists.at(-1)), [
      ['p1/4/0', 'closed', 'a = 1'],
      ['p1/4/1', 'closed', 'b = 2'],
    ]);
    for (let at = 1; at < lists.length; at += 1) {
      assert.notDeepEqual(brief(lists[at]), brief(lists[at - 1]));
    }
  });

  test('an unknown Thread gives [] once', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    await open(probe);
    const { lists } = watch(state.views, unknownThreadId);
    await settle(150);

    assert.deepEqual(lists, [[]]);
  });

  test('a tag with no fence renderer gives [], then the list once one registers', async () => {
    const { probe, state } = fenceProbe([], ['probe-fence']);
    const window = await open(probe);
    const { lists } = watch(state.views);
    await settle(50);
    snapshot(
      window,
      answering(closed('a = 1'), 'p1', otherThreadId),
      otherThreadId,
    );
    await settle(150);
    assert.deepEqual(lists.at(-1), []);

    state.register('probe-ui', 'probe-fence');
    await settle(150);

    assertReady(state);
    assert.deepEqual(brief(lists.at(-1)), [['p1/4/0', 'closed', 'a = 1']]);
  });

  test('a deleted Thread gives [] and ends the watch', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await open(probe);
    const { lists } = watch(state.views);
    await settle(50);
    snapshot(
      window,
      answering(closed('a = 1'), 'p1', otherThreadId),
      otherThreadId,
    );
    await settle(150);
    assert.equal(lists.at(-1)?.length, 1);

    streamOf(window, otherThreadId)
      .at(-1)
      ?.push({ kind: 'deleted', projectId, threadId: otherThreadId });
    await settle(150);

    assert.deepEqual(lists.at(-1), []);
    assert.equal(streamOf(window, otherThreadId).length, 0);
  });

  test('the conversation opening 21 other Threads leaves the watch live', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await open(probe);
    const { lists } = watch(state.views);
    await settle(50);
    snapshot(
      window,
      answering(closed('a = 1'), 'p1', otherThreadId),
      otherThreadId,
    );
    await settle(150);

    for (const id of visited) {
      window.window.history.pushState(null, '', threadPath(id));
      window.window.dispatchEvent(new window.window.PopStateEvent('popstate'));
      await settle(20);
    }
    await settle(100);

    assert.equal(streamOf(window, otherThreadId).length, 1);
    push(
      window,
      threadEvent(
        5,
        { type: 'text.delta', delta: `\n\n${closed('b = 2')}` },
        'p1',
        otherThreadId,
      ),
      otherThreadId,
    );
    await settle(150);
    assert.deepEqual(brief(lists.at(-1)), [
      ['p1/4/0', 'closed', 'a = 1'],
      ['p1/4/1', 'closed', 'b = 2'],
    ]);
  });

  test('two subscriptions of one Thread open one stream, and disposing both releases it', async () => {
    const { probe, state } = fenceProbe([['probe-ui', 'probe-fence']]);
    const window = await open(probe);
    const first = watch(state.views);
    const second = watch(state.views);
    await settle(150);

    assert.equal(streamOf(window, otherThreadId).length, 1);

    first.subscription.dispose();
    await settle(50);
    assert.equal(streamOf(window, otherThreadId).length, 1);

    second.subscription.dispose();
    await settle(50);
    assert.equal(streamOf(window, otherThreadId).length, 0);
  });
});
