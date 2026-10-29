// The conversation asking a canvas to open one thread (`desktop/ui/canvas`):
// a DOM event on the document names the comment and its target. Only a
// request for this artifact is answered; the canvas (modal) always shows it,
// and in the conversation only the node of the right revision does — the
// target's own, else the artifact's newest, as the registry (a boundary,
// faked here) or the record read says.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { type ThreadOpenInput, useThreadOpenRequests } from 'desktop/ui/canvas';

import { act, closeDom, renderHook, settle } from './support/dom.js';

after(closeDom);

const EVENT = 'test:comment-thread-open';

const setup = async (overrides: Partial<ThreadOpenInput> = {}) => {
  const shown: string[] = [];
  const input: ThreadOpenInput = {
    chrome: 'canvas',
    artifactId: 'a1',
    ownRevision: 2,
    knownRevisions: 2,
    latestRevision: async () => 2,
    eventName: EVENT,
    showThread: (commentId) => shown.push(commentId),
    ...overrides,
  };
  const hook = await renderHook(
    (props: ThreadOpenInput) => useThreadOpenRequests(props),
    input,
  );
  return { shown, hook };
};

const ask = async (target: {
  readonly kind: string;
  readonly id: string;
  readonly revision?: number;
}) => {
  await act(() => {
    document.dispatchEvent(
      new CustomEvent(EVENT, { detail: { commentId: 'c1', target } }),
    );
  });
  await settle();
};

describe('the canvas (modal)', () => {
  test('shows a thread of its artifact', async () => {
    const { shown, hook } = await setup();
    await ask({ kind: 'artifact', id: 'a1' });
    assert.deepEqual(shown, ['c1']);
    await hook.unmount();
  });

  test('ignores another artifact, or another kind of target', async () => {
    const { shown, hook } = await setup();
    await ask({ kind: 'artifact', id: 'a2' });
    await ask({ kind: 'file', id: 'a1' });
    assert.deepEqual(shown, []);
    await hook.unmount();
  });
});

describe('a conversation node', () => {
  test('with a revision named, only the node of that revision shows it', async () => {
    const own = await setup({ chrome: 'node', ownRevision: 2 });
    await ask({ kind: 'artifact', id: 'a1', revision: 2 });
    assert.deepEqual(own.shown, ['c1']);
    await own.hook.unmount();

    const other = await setup({ chrome: 'node', ownRevision: 3 });
    await ask({ kind: 'artifact', id: 'a1', revision: 2 });
    assert.deepEqual(other.shown, []);
    await other.hook.unmount();
  });

  test('without a revision, only the node of the newest revision shows it', async () => {
    const newest = await setup({
      chrome: 'node',
      ownRevision: 4,
      latestRevision: async () => 4,
    });
    await ask({ kind: 'artifact', id: 'a1' });
    assert.deepEqual(newest.shown, ['c1']);
    await newest.hook.unmount();

    const older = await setup({
      chrome: 'node',
      ownRevision: 3,
      latestRevision: async () => 4,
    });
    await ask({ kind: 'artifact', id: 'a1' });
    assert.deepEqual(older.shown, []);
    await older.hook.unmount();
  });

  test('when the registry cannot say, the revisions the record knows decide', async () => {
    const unreachable = async (): Promise<number | undefined> => {
      throw new Error('registry unavailable');
    };

    const newest = await setup({
      chrome: 'node',
      ownRevision: 5,
      knownRevisions: 5,
      latestRevision: unreachable,
    });
    await ask({ kind: 'artifact', id: 'a1' });
    assert.deepEqual(newest.shown, ['c1']);
    await newest.hook.unmount();

    const older = await setup({
      chrome: 'node',
      ownRevision: 4,
      knownRevisions: 5,
      latestRevision: unreachable,
    });
    await ask({ kind: 'artifact', id: 'a1' });
    assert.deepEqual(older.shown, []);
    await older.hook.unmount();
  });

  test('stops listening once it unmounts', async () => {
    const { shown, hook } = await setup({ chrome: 'node' });
    await hook.unmount();
    await ask({ kind: 'artifact', id: 'a1', revision: 2 });
    assert.deepEqual(shown, []);
  });
});
