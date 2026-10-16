// A stored prompt is the envelope the send built; every surface that shows it
// as the reader's words shows only its `<message>` — the comments are the
// turn's margin, drawn from `comments.added/v1` — while a plain-text prompt
// (any prompt sent before the envelope) shows exactly as it was written.
//
// Contract matrix:
// - the user turn shows the message of an envelope, a plain prompt as is;
// - a queued receipt and a rail marker of a prompt of comments alone read
//   as its notes;
// - a queue row reads the stored envelope's words, and the host's preview of
//   a plain prompt as is;
// - the pending turn of a send shows the words, never the envelope.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  emptyProjection,
  projectEvents,
  type Turn,
} from '../src/client/domain/projector.js';
import { promptEnvelope } from '../src/client/domain/prompt-envelope.js';
import { type QueueItem, queueRowText } from '../src/client/domain/queue.js';
import { threadMarkers } from '../src/client/domain/thread-nav.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';
import { createThreadChatsStore } from '../src/client/stores/thread-chats.js';
import type { ComposerItem } from '../src/contracts/index.js';

const event = (
  sequence: number,
  promptId: string,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
): ThreadEvent => ({
  projectId: 'project',
  threadId: 'thread',
  promptId,
  sequence,
  type: value.type,
  event: value,
  createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
});

const comment: ComposerItem = {
  id: 'comment-a',
  kind: 'preview',
  elementTag: 'papercraft-comment-line',
  data: {
    target: {
      kind: 'artifact',
      id: 'art_1',
      revision: 1,
      anchor: { form: 'point', x: 1, y: 2 },
    },
    pin: 1,
  },
  note: 'mais respiro',
};

const userText = (turns: readonly Turn[]): string | undefined => {
  const turn = turns.find((each) => each.type === 'user');
  return turn?.type === 'user' ? turn.text : undefined;
};

describe('reading a stored prompt back', () => {
  test("the user turn shows the envelope's words, and a plain prompt as written", () => {
    const envelope = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: promptEnvelope('Ajusta isso', [comment]),
        source: { kind: 'user' },
      }),
    ]);
    const plain = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: '<b>Hi</b>\n\n- a list',
        source: { kind: 'user' },
      }),
    ]);

    assert.equal(userText(envelope.turns), 'Ajusta isso');
    assert.equal(userText(plain.turns), '<b>Hi</b>\n\n- a list');
  });

  test('a queued receipt of comments alone reads as its notes', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: promptEnvelope('', [comment]),
        source: { kind: 'user' },
        queued: true,
      }),
      event(2, 'one', { type: 'prompt.queued' }),
    ]);
    const receipt = projection.turns.find((turn) => turn.type === 'queued');

    assert.equal(
      receipt?.type === 'queued' ? receipt.items[0]?.text : undefined,
      'mais respiro',
    );
  });

  test("a prompt of comments alone marks the rail with the comments' notes", () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: promptEnvelope('', [comment]),
        source: { kind: 'user' },
      }),
      event(2, 'one', {
        type: 'comments.added/v1',
        commentId: 'comment-a',
        target: { kind: 'artifact', id: 'art_1' },
        text: 'mais respiro',
      }),
    ]);

    assert.deepEqual(
      threadMarkers(projection.turns).map((marker) => marker.text),
      ['mais respiro'],
    );
  });

  test("a queue row reads the stored envelope's words", () => {
    const item: QueueItem = {
      promptId: 'one',
      source: { kind: 'user' },
      label: 'jao',
      preview: '<comments> <target kind="artifact" id="art_1" revision="1">',
      acceptedAt: '2026-01-01T00:00:00.000Z',
    };
    const stored = promptEnvelope('Ajusta\nisso', [comment]);

    assert.equal(queueRowText(item, stored), 'Ajusta isso');
    // Without the stored text the cut preview is all there is.
    assert.equal(
      queueRowText({ ...item, preview: 'Corrige o parser' }, undefined),
      'Corrige o parser',
    );
    // Another source's preview is the host's, whatever it holds.
    assert.equal(
      queueRowText({ ...item, source: { kind: 'terminal' } }, stored),
      item.preview,
    );
  });

  test('the pending turn of a send shows the words, never the envelope', async () => {
    const store = createThreadChatsStore({
      watch: { watch: () => () => undefined } as never,
      threads: {
        history: async () => null,
        prompt: () => new Promise(() => undefined),
        rewind: async () => ({ promptId: 'p' }),
        resume: async () => {
          throw new Error('unused');
        },
      } as never,
      history: { write: () => undefined },
    });
    store.getState().open({
      id: 't1',
      projectId: 'p1',
      name: 'Thread',
      state: 'idle',
      cwd: '/workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    await new Promise((done) => setImmediate(done));

    void store.getState().prompt('t1', promptEnvelope('Oi', [comment]));

    assert.equal(store.getState().chats.chats.get('t1')?.pending?.text, 'Oi');
  });
});
