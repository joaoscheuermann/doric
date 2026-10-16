// `chat.send/v1`: a surface outside the composer (the papercraft canvas)
// sends a Thread's held draft — the stack's comments and the draft text — as
// its own prompt envelope through the window's send path, which flushes the
// stack only after the host accepted the prompt.
//
// Contract matrix:
// - the stack's notes and the draft text become the envelope, sent in the
//   Thread with its Project;
// - an accepted send clears the draft text; a refused one leaves it;
// - a draft with nothing written sends nothing;
// - the store's send flushes a Thread this window never opened, in the
//   Project the caller named, and only once accepted.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ThreadWatch } from '../src/client/api/thread-watch.js';
import { parsePromptEnvelope } from '../src/client/domain/prompt-envelope.js';
import {
  type ChatSendDependencies,
  sendStack,
} from '../src/client/services/send.js';
import { createThreadChatsStore } from '../src/client/stores/thread-chats.js';
import type { ComposerItem } from '../src/contracts/index.js';

const item = (note: string): ComposerItem => ({
  id: `comment-${note.length}`,
  kind: 'preview',
  elementTag: 'papercraft-comment-line',
  data: {
    target: {
      kind: 'artifact',
      id: 'checkout-7f3a',
      revision: 1,
      anchor: { form: 'source', path: 'src/Checkout.tsx', line: 42 },
    },
    pin: 1,
  },
  note,
});

/** A host-held draft and the host's answer, with what the send did to them. */
const draft = (text: string, items: readonly ComposerItem[], accept = true) => {
  const held = { text };
  const sent: { id: string; text: string; projectId: string }[] = [];
  const dependencies: ChatSendDependencies = {
    read: async (thread) => ({ threadId: thread.id, text: held.text, items }),
    prompt: async (id, prompt, options) => {
      sent.push({ id, text: prompt, projectId: options.projectId });
      return accept;
    },
    setText: (_thread, next) => {
      held.text = next;
    },
  };
  return { held, sent, dependencies };
};

describe('chat.send/v1', () => {
  test("sends the stack's notes and the draft words as the Thread's prompt", async () => {
    const { sent, dependencies } = draft('palavras do editor', [
      item('mais respiro no botão'),
    ]);

    const result = await sendStack(
      { projectId: 'p1', threadId: 't1' },
      dependencies,
    );

    assert.deepEqual(result, { status: 'accepted' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.id, 't1');
    assert.equal(sent[0]?.projectId, 'p1');
    const envelope = parsePromptEnvelope(sent[0]?.text ?? '');
    assert.equal(envelope?.message, 'palavras do editor');
    assert.deepEqual(
      envelope?.comments.map((comment) => comment.text),
      ['mais respiro no botão'],
    );
  });

  test('an accepted send clears the draft words; a refused one keeps them', async () => {
    const accepted = draft('palavras', [item('oi')]);
    await sendStack({ projectId: 'p1', threadId: 't1' }, accepted.dependencies);
    assert.equal(accepted.held.text, '');

    const refused = draft('palavras', [item('oi')], false);
    const result = await sendStack(
      { projectId: 'p1', threadId: 't1' },
      refused.dependencies,
    );
    assert.deepEqual(result, { status: 'refused' });
    assert.equal(refused.held.text, 'palavras');
  });

  test('draft words alone are a prompt of their own', async () => {
    const { sent, held, dependencies } = draft('só as palavras', []);

    const result = await sendStack(
      { projectId: 'p1', threadId: 't1' },
      dependencies,
    );

    assert.deepEqual(result, { status: 'accepted' });
    assert.equal(sent[0]?.text, '<message>\nsó as palavras\n</message>');
    assert.equal(held.text, '');
  });

  test('a draft with nothing written sends nothing', async () => {
    const { sent, dependencies } = draft('  ', [item('   ')]);

    const result = await sendStack(
      { projectId: 'p1', threadId: 't1' },
      dependencies,
    );

    assert.deepEqual(result, { status: 'empty' });
    assert.equal(sent.length, 0);
  });
});

describe('the store send from outside the conversation', () => {
  const storeWith = (accept: boolean) => {
    const flushes: unknown[] = [];
    const watch: ThreadWatch = { watch: () => () => undefined } as never;
    const store = createThreadChatsStore({
      watch,
      threads: {
        history: async () => null,
        prompt: async () => {
          if (!accept) throw new Error('refused');

          return { promptId: 'pr1' };
        },
        rewind: async () => ({ promptId: 'pr1' }),
        resume: async () => {
          throw new Error('unused');
        },
      } as never,
      history: { write: () => undefined },
      flush: async (input) => {
        flushes.push(input);
      },
    });

    return { store, flushes };
  };

  test('flushes a Thread the window never opened, in the named Project', async () => {
    const { store, flushes } = storeWith(true);

    assert.equal(
      await store.getState().prompt('t1', 'oi', { projectId: 'p1' }),
      true,
    );
    assert.deepEqual(flushes, [
      { threadId: 't1', projectId: 'p1', promptId: 'pr1' },
    ]);
  });

  test('never flushes a refused send', async () => {
    const { store, flushes } = storeWith(false);

    assert.equal(
      await store.getState().prompt('t1', 'oi', { projectId: 'p1' }),
      false,
    );
    assert.deepEqual(flushes, []);
  });
});
