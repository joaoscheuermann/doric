// The comment flow of a canvas (`desktop/ui/canvas`), driven through the
// owner's composer stack (`CommentStore`, faked here: it is the boundary to
// chat's composer and the registry). A new note joins the stack only once it
// is confirmed; a reply answers its thread's root on the root's own target; an
// edit updates its draft and an emptied one is removed; chat's send confirms
// the open note first. The anchor is a stand-in owner's `{ cell }`.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  artifactTargetOf,
  type CanvasComment,
  type CanvasCommentData,
  type CanvasDraft,
  type CommentFlowInput,
  type CommentOutcome,
  type CommentStore,
  nextPinOf,
  threadsOf,
  useCommentFlow,
} from 'desktop/ui/canvas';

import { act, closeDom, renderHook, settle } from './support/dom.js';

after(closeDom);

interface Cell {
  readonly cell: string;
}

const SEND_EVENT = 'test:prompt-send';

/** The owner's stack: records what the flow asked of it, in order. */
const fakeStore = (
  begin: (
    data: CanvasCommentData<Cell>,
    note: string,
  ) => Promise<CommentOutcome> = async () => ({ kind: 'stack', itemId: 'new' }),
) => {
  const calls: {
    readonly method: string;
    readonly args: readonly unknown[];
  }[] = [];
  const store: CommentStore<CanvasCommentData<Cell>> = {
    begin: (data, note) => {
      calls.push({ method: 'begin', args: [data, note] });
      return begin(data, note);
    },
    edit: async (itemId, note) => {
      calls.push({ method: 'edit', args: [itemId, note] });
    },
    remove: async (itemId) => {
      calls.push({ method: 'remove', args: [itemId] });
    },
    send: async () => {
      calls.push({ method: 'send', args: [] });
      return 'accepted';
    },
    resolve: async (input) => {
      calls.push({ method: 'resolve', args: [input] });
      return 'done';
    },
    promptSendEvent: SEND_EVENT,
  };
  const of = (method: string) =>
    calls.filter((call) => call.method === method).map((call) => call.args);
  return { store, calls, of };
};

const comment = (
  commentId: string,
  fields: Partial<CanvasComment<Cell>> = {},
): CanvasComment<Cell> => ({
  commentId,
  text: `${commentId} text`,
  resolved: false,
  ...fields,
});

const threads = threadsOf<Cell>([
  comment('r1', { anchor: { cell: 'A1' }, revision: 2, promptId: 'prompt-1' }),
]);

const drafts: CanvasDraft<Cell>[] = [
  {
    id: 'reply-draft',
    note: 'old note',
    inReplyTo: 'r1',
    target: artifactTargetOf('a1', 2, { cell: 'A1' }),
    pin: 1,
  },
  {
    id: 'd1',
    note: 'draft root',
    target: artifactTargetOf('a1', 3, { cell: 'gone' }),
    pin: 2,
  },
  {
    id: 'd1-reply',
    note: 'draft reply',
    inReplyTo: 'd1',
    target: artifactTargetOf('a1', 3, { cell: 'gone' }),
    pin: 2,
  },
];

const refs = { title: 'Sheet', source: 'sheet.drawio' };

const setup = async (
  store: CommentStore<CanvasCommentData<Cell>>,
  overrides: Partial<CommentFlowInput<Cell>> = {},
) => {
  let reloads = 0;
  const input: CommentFlowInput<Cell> = {
    store,
    threadId: 't1',
    artifactId: 'a1',
    revision: 3,
    threads,
    drafts,
    refs,
    reloadComments: () => {
      reloads += 1;
    },
    showResolvedPins: () => undefined,
    container: { current: null },
    ...overrides,
  };
  const hook = await renderHook(
    (props: CommentFlowInput<Cell>) => useCommentFlow(props),
    input,
  );
  return { flow: () => hook.result(), reloads: () => reloads, hook };
};

const pinOf = (key: string) => ({
  key,
  pin: 1,
  point: { x: 0, y: 0 },
  state: 'open' as const,
  replies: 0,
  note: '',
});

describe('a new comment', () => {
  test('joins the stack once confirmed, on the revision on screen with the next pin', async () => {
    const { store, of } = fakeStore();
    const { flow, hook } = await setup(store);

    await act(() => flow().beginNew({ cell: 'B2' }, { x: 4, y: 5 }));
    assert.equal(flow().open?.kind, 'new');
    assert.deepEqual(of('begin'), []);

    await act(() => flow().setText('  look here  '));
    await act(() => flow().confirmInput());

    assert.deepEqual(of('begin'), [
      [
        {
          target: artifactTargetOf('a1', 3, { cell: 'B2' }),
          pin: nextPinOf(threads, drafts),
          point: { x: 4, y: 5 },
          refs,
        },
        'look here',
      ],
    ]);
    assert.equal(flow().open, undefined);
    await hook.unmount();
  });

  test('an empty note joins nothing', async () => {
    const { store, of } = fakeStore();
    const { flow, hook } = await setup(store);

    await act(() => flow().beginNew({ cell: 'B2' }, { x: 4, y: 5 }));
    await act(() => flow().setText('   '));
    await act(() => flow().confirmInput());

    assert.deepEqual(of('begin'), []);
    assert.equal(flow().open, undefined);
    await hook.unmount();
  });

  test('opens nothing while no revision is on screen', async () => {
    const { store } = fakeStore();
    const { flow, hook } = await setup(store, { revision: undefined });

    await act(() => flow().beginNew({ cell: 'B2' }, { x: 4, y: 5 }));

    assert.equal(flow().open, undefined);
    await hook.unmount();
  });

  test('a stack that refuses it throws nothing, and the input closes', async () => {
    const { store } = fakeStore(async () => {
      throw new Error('no composer');
    });
    const { flow, hook } = await setup(store);

    await act(() => flow().beginNew({ cell: 'B2' }, { x: 4, y: 5 }));
    await act(() => flow().setText('note'));
    await act(() => flow().confirmInput());

    assert.equal(flow().open, undefined);
    await hook.unmount();
  });
});

describe('a thread', () => {
  test('a reply answers the root on the root’s own target and pin', async () => {
    const { store, of } = fakeStore();
    const { flow, hook } = await setup(store);

    await act(() => flow().openPin(pinOf('r1')));
    await act(() => flow().setText('a reply'));
    await act(() => flow().confirmInput());

    const [[data, note] = []] = of('begin') as unknown as [
      CanvasCommentData<Cell>,
      string,
    ][];
    assert.equal(note, 'a reply');
    assert.deepEqual(data?.target, artifactTargetOf('a1', 2, { cell: 'A1' }));
    assert.equal(data?.pin, 1);
    assert.equal(data?.inReplyTo, 'r1');
    await hook.unmount();
  });

  test('an edited draft is edited; an emptied one is removed', async () => {
    const { store, of } = fakeStore();
    const { flow, hook } = await setup(store);

    await act(() => flow().openPin(pinOf('r1')));
    await act(() => flow().editDraft('reply-draft'));
    assert.equal(flow().text, 'old note');
    await act(() => flow().setText('new note'));
    await act(() => flow().confirmInput(false));
    assert.deepEqual(of('edit'), [['reply-draft', 'new note']]);

    await act(() => flow().editDraft('reply-draft'));
    await act(() => flow().setText(''));
    await act(() => flow().confirmInput());
    await settle();
    assert.deepEqual(of('remove'), [['reply-draft']]);
    await hook.unmount();
  });

  test('removing a draft root removes its draft replies too', async () => {
    const { store, of } = fakeStore();
    const { flow, hook } = await setup(store);

    await act(() => flow().removeDraft('d1'));
    await settle();

    assert.deepEqual(
      of('remove')
        .map(([id]) => id)
        .sort(),
      ['d1', 'd1-reply'],
    );
    await hook.unmount();
  });

  test('toggling resolves the sent root under its own prompt, then rereads', async () => {
    const { store, of } = fakeStore();
    const { flow, reloads, hook } = await setup(store);

    await act(() => flow().openPin(pinOf('r1')));
    await act(() => flow().toggleResolved());
    await settle();

    assert.deepEqual(of('resolve'), [
      [{ commentId: 'r1', promptId: 'prompt-1', resolved: true }],
    ]);
    assert.equal(reloads(), 1);
    await hook.unmount();
  });
});

describe('sending', () => {
  test('sendNow confirms the open note before it sends the stack', async () => {
    const { store, calls } = fakeStore();
    const { flow, hook } = await setup(store);

    await act(() => flow().beginNew({ cell: 'B2' }, { x: 4, y: 5 }));
    await act(() => flow().setText('note'));
    await act(() => flow().sendNow());

    assert.deepEqual(
      calls.map((call) => call.method),
      ['begin', 'send'],
    );
    await hook.unmount();
  });

  test('chat’s send for this Thread waits for the open note’s confirmation', async () => {
    const { store, of } = fakeStore();
    const { flow, hook } = await setup(store);

    await act(() => flow().beginNew({ cell: 'B2' }, { x: 4, y: 5 }));
    await act(() => flow().setText('note'));

    const pending: Promise<unknown>[] = [];
    await act(() => {
      document.dispatchEvent(
        new CustomEvent(SEND_EVENT, {
          detail: {
            threadId: 't1',
            waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          },
        }),
      );
    });
    assert.equal(pending.length, 1);
    await act(async () => {
      await Promise.all(pending);
    });

    assert.equal(of('begin').length, 1);
    assert.equal(of('begin')[0]?.[1], 'note');
    await hook.unmount();
  });

  test('chat’s send for another Thread is not this canvas’s', async () => {
    const { store, of } = fakeStore();
    const { flow, hook } = await setup(store);

    await act(() => flow().beginNew({ cell: 'B2' }, { x: 4, y: 5 }));
    await act(() => flow().setText('note'));

    const pending: Promise<unknown>[] = [];
    await act(() => {
      document.dispatchEvent(
        new CustomEvent(SEND_EVENT, {
          detail: {
            threadId: 'another',
            waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          },
        }),
      );
    });
    await settle();

    assert.equal(pending.length, 0);
    assert.deepEqual(of('begin'), []);
    assert.equal(flow().open?.kind, 'new');
    await hook.unmount();
  });
});
