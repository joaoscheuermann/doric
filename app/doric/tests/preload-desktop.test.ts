// `window.doric.desktop` as the preload builds it: the two channels, the
// generation read from the shell's meta tag and the close protocol answers.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createDesktopApi,
  DESKTOP_CHANNEL,
  DESKTOP_PUSH_CHANNEL,
} from '../src/app/api/desktop';

const fakeIpc = (
  answer: (payload: Record<string, unknown>) => unknown = () => undefined,
) => {
  const invoked: { channel: string; payload: Record<string, unknown> }[] = [];
  let push: ((event: unknown, payload: unknown) => void) | undefined;

  return {
    invoked,
    ipc: {
      invoke: async (channel: string, payload: unknown) => {
        invoked.push({ channel, payload: payload as Record<string, unknown> });

        return answer(payload as Record<string, unknown>);
      },
      on: (
        channel: string,
        listener: (event: unknown, payload: unknown) => void,
      ) => {
        if (channel === DESKTOP_PUSH_CHANNEL) {
          push = listener;
        }
      },
    },
    push: (payload: unknown) => push?.({}, payload),
  };
};

const meta = (content: string | null) => ({
  querySelector: () =>
    content === null ? null : { getAttribute: () => content },
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('preload desktop API', () => {
  test('uses the channels desktop/client names', async () => {
    const protocol = (await import('desktop/protocol')) as {
      DESKTOP_CHANNEL: string;
      DESKTOP_PUSH_CHANNEL: string;
    };

    assert.equal(DESKTOP_CHANNEL, protocol.DESKTOP_CHANNEL);
    assert.equal(DESKTOP_PUSH_CHANNEL, protocol.DESKTOP_PUSH_CHANNEL);
  });

  test('sends the generation of the shell it runs in with every request', async () => {
    const fake = fakeIpc();
    const { api } = createDesktopApi(fake.ipc, () => meta('4'));

    await api.describeWindow();
    await api.ready();

    assert.deepEqual(
      fake.invoked.map(({ channel, payload }) => ({ channel, payload })),
      [
        {
          channel: 'doric:desktop',
          payload: { op: 'describeWindow', generation: 4 },
        },
        { channel: 'doric:desktop', payload: { op: 'ready', generation: 4 } },
      ],
    );
  });

  test('a page without a generation (the splash) sends none', async () => {
    const fake = fakeIpc();
    const { api } = createDesktopApi(fake.ipc, () => meta(null));

    await api.describeWindow();

    assert.deepEqual(fake.invoked[0]?.payload, { op: 'describeWindow' });
  });

  test('a window without a close handler allows the close', async () => {
    const fake = fakeIpc();

    createDesktopApi(fake.ipc);
    fake.push({
      type: 'close-requested',
      id: 'c1',
      request: { phase: 'close', forced: false, deadline: 0 },
    });
    await tick();

    assert.deepEqual(fake.invoked[0]?.payload, {
      op: 'closeAnswer',
      id: 'c1',
      answer: { allow: true },
    });
  });

  test('the veto phase answers what the bootstrap decided', async () => {
    const fake = fakeIpc();
    const { api } = createDesktopApi(fake.ipc);

    api.onCloseRequested(async () => ({ allow: false, reason: 'unsaved' }));
    fake.push({
      type: 'close-requested',
      id: 'c2',
      request: { phase: 'close', forced: false, deadline: 0 },
    });
    await tick();

    assert.deepEqual(fake.invoked[0]?.payload, {
      op: 'closeAnswer',
      id: 'c2',
      answer: { allow: false, reason: 'unsaved' },
    });
  });

  test('the flush phase answers only after the window flush settles', async () => {
    const fake = fakeIpc();
    const { api } = createDesktopApi(fake.ipc);
    const flushed: string[] = [];

    api.onCloseRequested(async (request) => {
      if (request.phase === 'flush') {
        await tick();
        flushed.push('settings saved');
      }
      return undefined;
    });
    fake.push({
      type: 'close-requested',
      id: 'c3',
      request: { phase: 'flush', forced: false, deadline: Date.now() + 1500 },
    });
    await tick();
    await tick();

    assert.deepEqual(flushed, ['settings saved']);
    assert.deepEqual(fake.invoked.at(-1)?.payload, {
      op: 'closeAnswer',
      id: 'c3',
      answer: { allow: true },
    });
  });

  test('stream events reach the subscriber until it unsubscribes', async () => {
    const fake = fakeIpc((payload) =>
      payload.op === 'subscribe' ? { ok: true, output: undefined } : undefined,
    );
    const { api } = createDesktopApi(fake.ipc);
    const events: unknown[] = [];
    const envelope = {
      id: 's1',
      contract: 'doric.shell/v1',
      method: 'keybindings',
      input: [],
      bundleId: null,
      deadline: 0,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    };
    const unsubscribe = api.subscribe(envelope, (event) => events.push(event));

    fake.push({ type: 'event', id: 's1', event: [] });
    unsubscribe();
    fake.push({ type: 'event', id: 's1', event: ['late'] });
    await tick();

    assert.deepEqual(events, [{ type: 'event', event: [] }]);
    assert.deepEqual(fake.invoked.at(-1)?.payload, {
      op: 'unsubscribe',
      id: 's1',
    });
  });
});
