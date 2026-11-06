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

import { isContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import type { ThreadWatch } from '../src/client/api/thread-watch.js';
import { parsePromptEnvelope } from '../src/client/domain/prompt-envelope.js';
import {
  type ChatSendDependencies,
  createChatSend,
  sendStack,
} from '../src/client/services/send.js';
import { createThreadChatsStore } from '../src/client/stores/thread-chats.js';
import {
  type ChatActionInput,
  ChatSendV1,
  type ComposerItem,
} from '../src/contracts/index.js';

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
        return [];
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

// `chat.send/v1.sendAction` (conversation-openui.md D20, C3): one click on a UI
// the agent drew, sent as the reader's next message by the composer's route,
// wrapped in a `<ui-action>` envelope, without touching the composer.
describe('chat.send/v1.sendAction', () => {
  const projectId = 'p1';
  const threadId = 't1';
  const runningId = '55555555-5555-4555-8555-555555555555';

  /** A Thread record as the host gives it. */
  const record = (overrides: Record<string, unknown> = {}) => ({
    id: threadId,
    name: 'Release',
    projectId,
    state: 'idle',
    cwd: '/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  const item = (promptId: string) => ({
    promptId,
    source: { kind: 'user' as const },
    label: 'jao',
    preview: 'later',
    acceptedAt: '2026-01-01T00:00:00.000Z',
  });

  const queue = (overrides: Record<string, unknown> = {}) => ({
    revision: 1,
    paused: false,
    stopping: false,
    items: [],
    ...overrides,
  });

  /**
   * The window's send over a fake host Thread API that answers as told and
   * writes down each call, and a composer whose every use is written down too.
   */
  const sending = (
    answers: {
      readonly get?: () => Promise<unknown>;
      readonly queue?: () => Promise<unknown>;
      readonly resumeQueue?: () => Promise<unknown>;
      readonly prompt?: () => Promise<unknown>;
    } = {},
  ) => {
    const calls: { method: string; args: unknown[] }[] = [];
    const composer: string[] = [];
    const answer =
      (method: string, fallback: () => Promise<unknown>) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
        const given = (answers as Record<string, () => Promise<unknown>>)[
          method
        ];
        return (given ?? fallback)();
      };
    const dependencies = {
      read: async () => {
        composer.push('read');
        return { threadId, text: 'palavras', items: [] };
      },
      prompt: async () => {
        composer.push('prompt');
        return true;
      },
      setText: () => {
        composer.push('setText');
      },
      threads: {
        get: answer('get', async () => record()),
        steer: answer('steer', async () => ({
          promptId: runningId,
          status: 'steered',
        })),
        queue: answer('queue', async () => queue()),
        resumeQueue: answer('resumeQueue', async () => record()),
        prompt: answer('prompt', async () => ({ promptId: 'new' })),
      } as unknown as ChatSendDependencies['threads'],
    };
    const services = createTestServices({
      bundle: { id: 'openui' },
      provide: [createChatSend(dependencies)],
    });
    const send = services.services.use(ChatSendV1);
    return {
      calls,
      composer,
      methods: () => calls.map((call) => call.method),
      sendAction: (input: Partial<ChatActionInput> = {}) =>
        send.sendAction({
          projectId,
          threadId,
          program: 'release',
          text: 'Tag the release',
          ...input,
        }),
      dispose: services.dispose,
    };
  };

  const envelope =
    '<ui-action program="release">\nTag the release\n</ui-action>';

  test('steers the running prompt with the envelope, with no interrupt', async () => {
    const run = sending({
      get: async () => record({ state: 'running', activePromptId: runningId }),
    });

    assert.deepEqual(await run.sendAction(), { status: 'accepted' });
    const steer = run.calls.find((call) => call.method === 'steer');
    assert.deepEqual(steer?.args, [
      threadId,
      envelope,
      { promptId: runningId },
    ]);
    assert.equal(run.methods().includes('prompt'), false);
    await run.dispose();
  });

  test('prompts with the envelope when no prompt runs', async () => {
    const run = sending();

    assert.deepEqual(await run.sendAction(), { status: 'accepted' });
    const prompt = run.calls.find((call) => call.method === 'prompt');
    assert.deepEqual(prompt?.args, [threadId, envelope]);
    assert.equal(run.methods().includes('resumeQueue'), false);
    await run.dispose();
  });

  test('resumes a paused, empty queue first, then prompts', async () => {
    const run = sending({ queue: async () => queue({ paused: true }) });

    assert.deepEqual(await run.sendAction(), { status: 'accepted' });
    assert.deepEqual(
      run
        .methods()
        .filter((method) => method === 'resumeQueue' || method === 'prompt'),
      ['resumeQueue', 'prompt'],
    );
    await run.dispose();
  });

  test('does not resume a paused queue that holds a resumable prompt or items', async () => {
    for (const held of [
      { resumable: item('paused') },
      { items: [item('later')] },
    ]) {
      const run = sending({
        queue: async () => queue({ paused: true, ...held }),
      });

      assert.deepEqual(await run.sendAction(), { status: 'accepted' });
      assert.equal(run.methods().includes('resumeQueue'), false);
      assert.ok(run.methods().includes('prompt'));
      await run.dispose();
    }
  });

  test('a prompt or a resume that throws is refused', async () => {
    const thrown = async () => {
      throw new Error('The thread cannot perform this operation.');
    };
    const prompt = sending({ prompt: thrown });
    assert.deepEqual(await prompt.sendAction(), { status: 'refused' });
    await prompt.dispose();

    const resume = sending({
      queue: async () => queue({ paused: true }),
      resumeQueue: thrown,
    });
    assert.deepEqual(await resume.sendAction(), { status: 'refused' });
    assert.equal(resume.methods().includes('prompt'), false);
    await resume.dispose();
  });

  test("an agent's Thread, another Project's Thread and a missing Thread are refused with no other call", async () => {
    const cases = {
      agent: async () =>
        record({ origin: 'agent', parentThreadId: 'parent-thread' }),
      otherProject: async () => record({ projectId: 'p2' }),
      missing: async () => undefined,
      failed: async () => {
        throw new Error('The host is away.');
      },
    };
    for (const [name, get] of Object.entries(cases)) {
      const run = sending({ get });
      assert.deepEqual(await run.sendAction(), { status: 'refused' }, name);
      assert.deepEqual(run.methods(), ['get'], name);
      await run.dispose();
    }
  });

  test("an accepted send leaves the composer's draft and stack alone", async () => {
    const run = sending();

    assert.deepEqual(await run.sendAction(), { status: 'accepted' });
    assert.deepEqual(run.composer, []);
    await run.dispose();
  });

  test('a text with leading and trailing blank lines reaches the prompt unchanged inside the envelope', async () => {
    const run = sending();

    assert.deepEqual(await run.sendAction({ text: '\n\nTag it\n\n' }), {
      status: 'accepted',
    });
    const prompt = run.calls.find((call) => call.method === 'prompt');
    assert.deepEqual(prompt?.args, [
      threadId,
      '<ui-action program="release">\n\n\nTag it\n\n\n</ui-action>',
    ]);
    await run.dispose();
  });

  test('a text over 16,000 code units, a blank text and the program `Release` are invalid_input, and call no Thread method', async () => {
    const invalid = {
      long: { text: 'a'.repeat(16_001) },
      blank: { text: '   \n  ' },
      program: { program: 'Release' },
    };
    for (const [name, input] of Object.entries(invalid)) {
      const run = sending();
      await assert.rejects(
        // A service checks its input before it runs, as it is called.
        async () => run.sendAction(input),
        (error: unknown) =>
          isContractError(error) && error.code === 'invalid_input',
        name,
      );
      assert.deepEqual(run.methods(), [], name);
      await run.dispose();
    }
  });
});
