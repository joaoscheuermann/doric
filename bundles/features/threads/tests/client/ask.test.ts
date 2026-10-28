// An ask in a conversation, as the reader meets it once the threads bundle
// draws `threads.asked/v1` for chat (DORIC-83): one question at a time, the
// picks, Back/Next/Send, the answers sent through `threads.ask/v1.answer` in
// the asked row's scope, and the block following its ask's status — answered
// here or elsewhere, or superseded by a later ask.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  openThreadsWindow,
  settle,
  type ThreadsWindow,
} from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const askId = '55555555-5555-4555-8555-555555555555';
const laterAskId = '66666666-6666-4666-8666-666666666666';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;
const scopeOfAsk = { projectId, threadId, promptId };

const thread = {
  id: threadId,
  name: 'Design the ask tool',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const context = 'Three points change the design before the spec.';

const questions = [
  {
    id: 'who',
    question: 'Who may call the ask tool?',
    options: [
      {
        label: 'Only the main thread',
        description: 'Subagents hand the doubt to their coordinator.',
        recommended: true,
      },
      { label: 'Any thread' },
    ],
  },
  {
    id: 'scope',
    question: 'What goes in the first version?',
    multiSelect: true,
    options: [
      { label: 'Single choice' },
      { label: 'Multiple choice' },
      { label: 'Free answer' },
    ],
  },
  {
    id: 'wait',
    question: 'What does the agent do until the answer arrives?',
    options: [{ label: 'Stop and wait' }, { label: 'Keep working' }],
  },
];

const laterQuestions = [
  {
    id: 'ship',
    question: 'Ship the migration today?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  },
];

const row = (
  type: string,
  payload: Record<string, unknown>,
  sequence: number,
) => ({
  projectId,
  threadId,
  promptId,
  sequence,
  type,
  event: { type, ...payload },
  createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
});

const accepted = row(
  'prompt.accepted',
  { text: 'Plan the ask tool.', source: { kind: 'user' } },
  1,
);
const asked = row('threads.asked/v1', { askId, context, questions }, 2);

/** A two-question ask: a single-select question, then a multi-select one. */
const pairId = '77777777-7777-4777-8777-777777777777';
const askedPair = row(
  'threads.asked/v1',
  { askId: pairId, questions: questions.slice(0, 2) },
  2,
);

type Status =
  | { readonly state: 'pending' }
  | { readonly state: 'answered'; readonly answers: readonly unknown[] }
  | { readonly state: 'superseded' };

/** The host behind `threads.ask/v1`: each ask's status, and how `answer` answers. */
const askHost = (statuses: Record<string, Status>) => {
  const answers: unknown[] = [];
  let answer = (input: { readonly answers: readonly unknown[] }): unknown => ({
    state: 'answered',
    answers: input.answers,
  });
  return {
    statuses,
    answers,
    answerWith(next: typeof answer) {
      answer = next;
    },
    host: {
      'runtime.threads/v1.thread': () => thread,
      'runtime.threads/v1.queue': () => ({
        revision: 1,
        paused: false,
        stopping: false,
        items: [],
      }),
      'threads.ask/v1.status': (input: unknown) => {
        const status = statuses[(input as { askId: string }).askId];
        if (status === undefined)
          throw { code: 'not_found', message: 'No such ask.' };
        return status;
      },
      'threads.ask/v1.answer': (input: unknown) => {
        answers.push(input);
        return answer(input as { readonly answers: readonly unknown[] });
      },
    },
  };
};

const deliver = async (window: ThreadsWindow, events: readonly unknown[]) => {
  const watch = window.watches().at(-1);
  assert.notEqual(watch, undefined, 'the conversation watches its Thread');
  watch?.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread,
    events,
  });
  await settle(150);
  await settle(50);
};

const live = async (window: ThreadsWindow, event: unknown) => {
  window.watches().at(-1)?.push({ kind: 'event', event });
  await settle(150);
  await settle(50);
};

/** The `<threads-ask>` drawing one ask, inside chat's block of that ask. */
const blockOf = (window: ThreadsWindow, id = askId): HTMLElement | null =>
  window.document.querySelector(
    `[data-chat-block-id="ask:${id}"] threads-ask`,
  ) as HTMLElement | null;

const present = (window: ThreadsWindow, id = askId): HTMLElement => {
  const block = blockOf(window, id);
  assert.notEqual(
    block,
    null,
    `threads draws the ask in a <threads-ask> (blocks drawn: ${[
      ...window.document.querySelectorAll('[data-chat-block-id]'),
    ]
      .map(
        (host) =>
          `${host.getAttribute('data-chat-block-id')} <${
            host.querySelector('chat-block, threads-ask')?.localName ?? '?'
          }>`,
      )
      .join(', ')})`,
  );
  return block as HTMLElement;
};

const textOf = (element: Element): string => element.textContent ?? '';

const choices = (block: Element): HTMLElement[] => [
  ...block.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]'),
];

const choice = (block: Element, label: string): HTMLElement => {
  const found = choices(block).find((element) =>
    textOf(element).includes(label),
  );
  assert.notEqual(found, undefined, `the option "${label}" is shown`);
  return found as HTMLElement;
};

const checked = (block: Element, label: string): string | null =>
  choice(block, label).getAttribute('aria-checked');

const button = (block: Element, name: string): HTMLButtonElement | null =>
  block.querySelector(`button[aria-label="${name}"]`);

const press = async (block: Element, name: string) => {
  const found = button(block, name);
  assert.notEqual(found, null, `the ${name} button is shown`);
  found?.click();
  await settle(50);
};

const pick = async (block: Element, label: string) => {
  choice(block, label).click();
  await settle(50);
};

const freeAnswer = (block: Element): HTMLTextAreaElement | null =>
  block.querySelector('textarea[aria-label="Your answer"]');

/** Presses one key on `target`, as the reader would; returns the event to read `defaultPrevented`. */
const key = async (
  window: ThreadsWindow,
  target: Element,
  name: string,
  modifiers: { readonly ctrlKey?: boolean } = {},
): Promise<KeyboardEvent> => {
  const event = new window.window.KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  }) as unknown as KeyboardEvent;
  // A browser names the event it is dispatching as `window.event`, which the
  // chat editor reads while handling a key; happy-dom does not.
  const view = target.ownerDocument.defaultView as unknown as object;
  Object.defineProperty(view, 'event', { value: event, configurable: true });
  target.dispatchEvent(event);
  Reflect.deleteProperty(view, 'event');
  await settle(20);
  return event;
};

/** Types into the free answer as the reader would: React reads the input event. */
const type = async (window: ThreadsWindow, block: Element, text: string) => {
  const field = freeAnswer(block);
  assert.notEqual(field, null, 'the free answer is shown');
  const setter = Object.getOwnPropertyDescriptor(
    window.window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(field, text);
  field?.dispatchEvent(
    new window.window.Event('input', { bubbles: true }) as unknown as Event,
  );
  await settle(50);
};

const noControls = (block: Element) => {
  assert.equal(block.querySelectorAll('[role="radio"]').length, 0);
  assert.equal(block.querySelectorAll('[role="checkbox"]').length, 0);
  assert.equal(block.querySelectorAll('textarea').length, 0);
  assert.equal(button(block, 'Send'), null);
  assert.equal(button(block, 'Next'), null);
  assert.equal(button(block, 'Back'), null);
};

/** Picks every answer the Send test sends, ending on the last question. */
const fillAll = async (window: ThreadsWindow, block: Element) => {
  await pick(block, 'Only the main thread');
  await press(block, 'Next');
  await pick(block, 'Single choice');
  await pick(block, 'Free answer');
  await press(block, 'Next');
  await type(window, block, 'Wait for me');
};

const sentAnswers = [
  { id: 'who', options: ['Only the main thread'] },
  { id: 'scope', options: ['Single choice', 'Free answer'] },
  { id: 'wait', options: [], other: 'Wait for me' },
];

let opened: ThreadsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const open = async (statuses: Record<string, Status>) => {
  const ask = askHost(statuses);
  opened = await openThreadsWindow({ url, host: ask.host });
  await settle();
  return { ask, window: opened };
};

test('a pending ask opens on its first question, read in the scope of its row', async () => {
  const { window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);

  const block = present(window);
  const text = textOf(block);
  assert.match(text, /Who may call the ask tool\?/);
  assert.match(text, /1\/3/);
  assert.match(text, new RegExp(context));
  assert.doesNotMatch(text, /What goes in the first version\?/);
  assert.equal(choices(block).length, 2);
  assert.equal(
    choices(block).every((element) => element.getAttribute('role') === 'radio'),
    true,
  );
  assert.notEqual(freeAnswer(block), null);
  assert.equal(
    freeAnswer(block)?.getAttribute('placeholder'),
    'Type your answer...',
  );

  const reads = window.received('threads.ask/v1.status');
  assert.ok(reads.length >= 1, 'the block reads its status');
  const read = reads.at(-1);
  assert.deepEqual(read?.input, { askId });
  assert.equal(read?.scope?.projectId, scopeOfAsk.projectId);
  assert.equal(read?.scope?.threadId, scopeOfAsk.threadId);
  assert.equal(read?.scope?.promptId, scopeOfAsk.promptId);
});

test('Next goes on without a pick, and Back returns to the pick made', async () => {
  const { window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);
  const block = present(window);

  assert.equal(
    button(block, 'Next')?.disabled,
    false,
    'Next is enabled with nothing picked',
  );
  assert.equal(button(block, 'Back'), null);

  await pick(block, 'Any thread');
  assert.equal(checked(block, 'Any thread'), 'true');
  assert.equal(button(block, 'Next')?.disabled, false);

  await press(block, 'Next');
  assert.match(textOf(block), /2\/3/);
  assert.match(textOf(block), /What goes in the first version\?/);
  assert.doesNotMatch(textOf(block), new RegExp(context));

  await press(block, 'Back');
  assert.match(textOf(block), /1\/3/);
  assert.equal(checked(block, 'Any thread'), 'true');
  assert.equal(checked(block, 'Only the main thread'), 'false');
});

test('on a single-select question, typing a free answer takes the place of the option', async () => {
  const { window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);
  const block = present(window);

  await pick(block, 'Only the main thread');
  assert.equal(checked(block, 'Only the main thread'), 'true');

  const row = freeAnswer(block)?.closest('li');
  assert.match(textOf(row as Element), /3/, 'the free row shows its number');

  await type(window, block, 'Only me');
  assert.equal(checked(block, 'Only the main thread'), 'false');
  assert.equal(checked(block, 'Any thread'), 'false');
  assert.doesNotMatch(
    textOf(freeAnswer(block)?.closest('li') as Element),
    /3/,
    'the free row is marked picked',
  );
  assert.equal(button(block, 'Next')?.disabled, false);
});

test('on a multi-select question, options check and uncheck on their own', async () => {
  const { window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);
  const block = present(window);
  await pick(block, 'Any thread');
  await press(block, 'Next');

  assert.equal(
    choices(block).every(
      (element) => element.getAttribute('role') === 'checkbox',
    ),
    true,
  );
  assert.equal(
    button(block, 'Next')?.disabled,
    false,
    'Next is enabled with nothing checked',
  );

  await pick(block, 'Single choice');
  await pick(block, 'Multiple choice');
  assert.equal(checked(block, 'Single choice'), 'true');
  assert.equal(checked(block, 'Multiple choice'), 'true');
  assert.equal(checked(block, 'Free answer'), 'false');

  await pick(block, 'Single choice');
  assert.equal(checked(block, 'Single choice'), 'false');
  assert.equal(checked(block, 'Multiple choice'), 'true');
  assert.equal(button(block, 'Next')?.disabled, false);
});

test('keys typed in the free answer stay in it: the chat editor prevents none of them', async () => {
  const { window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);
  const block = present(window);
  const field = freeAnswer(block);
  assert.notEqual(field, null, 'the free answer is shown');

  field?.click();
  await settle(50);

  for (const [name, modifiers] of [
    ['Backspace', {}],
    ['Delete', {}],
    ['ArrowLeft', {}],
    ['ArrowRight', {}],
    ['Enter', {}],
    ['a', { ctrlKey: true }],
  ] as const) {
    const event = await key(window, field as Element, name, modifiers);
    assert.equal(
      event.defaultPrevented,
      false,
      `${modifiers.ctrlKey ? 'Ctrl+' : ''}${name} is left to the free answer`,
    );
  }
});

test('Next and Send go on with nothing picked: each skipped question is sent without picks', async () => {
  const { window } = await open({ [pairId]: { state: 'pending' } });
  await deliver(window, [accepted, askedPair]);
  const block = present(window, pairId);

  assert.equal(button(block, 'Next')?.disabled, false, 'Next is enabled');
  await press(block, 'Next');
  assert.match(textOf(block), /2\/2/);
  assert.equal(button(block, 'Send')?.disabled, false, 'Send is enabled');
  await press(block, 'Send');
  await settle(50);

  const sent = window.received('threads.ask/v1.answer');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.input, {
    askId: pairId,
    answers: [
      { id: 'who', options: [] },
      { id: 'scope', options: [] },
    ],
  });
});

test('Send is enabled on the last question with nothing picked, and disabled while the send is pending', async () => {
  const { ask, window } = await open({ [pairId]: { state: 'pending' } });
  await deliver(window, [accepted, askedPair]);
  const block = present(window, pairId);
  await pick(block, 'Any thread');
  await press(block, 'Next');

  assert.equal(
    button(block, 'Send')?.disabled,
    false,
    'Send is enabled with nothing picked',
  );

  let release: (value: unknown) => void = () => {};
  ask.answerWith(
    (input) =>
      new Promise((resolve) => {
        release = () => resolve({ state: 'answered', answers: input.answers });
      }),
  );
  await press(block, 'Send');
  assert.equal(
    button(block, 'Send')?.disabled,
    true,
    'Send is disabled while the send is pending',
  );
  release(undefined);
  await settle(50);
});

test('a skipped question shows "Skipped" in the answered block', async () => {
  const { ask, window } = await open({ [pairId]: { state: 'pending' } });
  await deliver(window, [accepted, askedPair]);
  const block = present(window, pairId);

  await pick(block, 'Any thread');
  await press(block, 'Next');
  await press(block, 'Send');
  await settle(50);

  const answers = [
    { id: 'who', options: ['Any thread'] },
    { id: 'scope', options: [] },
  ];
  const sent = window.received('threads.ask/v1.answer');
  assert.equal(sent.length, 1, 'the answers are sent');
  assert.deepEqual(sent[0]?.input, { askId: pairId, answers });

  ask.statuses[pairId] = { state: 'answered', answers };
  await live(window, row('threads.answered/v1', { askId: pairId, answers }, 3));

  const shown = present(window, pairId);
  assert.match(textOf(shown), /Answered/);
  const items = [...shown.querySelectorAll('ol li')];
  assert.equal(items.length, 2);
  assert.ok(textOf(items[0] as Element).includes('Any thread'));
  const second = textOf(items[1] as Element);
  assert.ok(second.includes('What goes in the first version?'), second);
  assert.ok(second.includes('Skipped'), second);
  noControls(shown);
});

test('Send answers in the scope of the asked row, and the block shows the answers', async () => {
  const { ask, window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);
  const block = present(window);

  await fillAll(window, block);
  assert.match(textOf(block), /3\/3/);
  assert.equal(button(block, 'Next'), null);
  assert.equal(button(block, 'Send')?.disabled, false);
  await press(block, 'Send');
  await settle(50);

  const sent = window.received('threads.ask/v1.answer');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.input, { askId, answers: sentAnswers });
  assert.equal(sent[0]?.scope?.projectId, projectId);
  assert.equal(sent[0]?.scope?.threadId, threadId);
  assert.equal(sent[0]?.scope?.promptId, promptId);
  assert.equal(ask.answers.length, 1);

  const shown = present(window);
  const text = textOf(shown);
  assert.match(text, /Answered/);
  assert.equal(shown.querySelectorAll('ol li').length, 3);
  for (const question of questions)
    assert.ok(text.includes(question.question), question.question);
  assert.ok(text.includes('Only the main thread'));
  assert.ok(text.includes('Single choice, Free answer'));
  assert.ok(text.includes('Wait for me'));
  noControls(shown);
});

test('an ask already answered shows its answers, without controls', async () => {
  const { window } = await open({
    [askId]: {
      state: 'answered',
      answers: [
        { id: 'who', options: ['Any thread'] },
        { id: 'scope', options: ['Single choice', 'Multiple choice'] },
        { id: 'wait', options: [], other: 'Keep going' },
      ],
    },
  });
  await deliver(window, [accepted, asked]);
  const block = present(window);

  const text = textOf(block);
  assert.match(text, /Answered/);
  for (const question of questions)
    assert.ok(text.includes(question.question), question.question);
  assert.ok(text.includes('Any thread'));
  assert.ok(text.includes('Single choice, Multiple choice'));
  assert.ok(text.includes('Keep going'));
  noControls(block);
});

test('a superseded ask shows its questions, without answers or controls', async () => {
  const { window } = await open({ [askId]: { state: 'superseded' } });
  await deliver(window, [accepted, asked]);
  const block = present(window);

  const text = textOf(block);
  assert.match(text, /Superseded/);
  assert.doesNotMatch(text, /Answered/);
  for (const question of questions)
    assert.ok(text.includes(question.question), question.question);
  assert.doesNotMatch(text, /Only the main thread|Any thread|Single choice/);
  noControls(block);
});

test('a later ask arriving live supersedes the open one, which reads its status again', async () => {
  const { ask, window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);
  assert.match(textOf(present(window)), /Who may call the ask tool\?/);
  const before = window.received('threads.ask/v1.status').length;

  ask.statuses[askId] = { state: 'superseded' };
  ask.statuses[laterAskId] = { state: 'pending' };
  await live(
    window,
    row(
      'threads.asked/v1',
      { askId: laterAskId, questions: laterQuestions },
      3,
    ),
  );

  const reads = window.received('threads.ask/v1.status');
  assert.ok(
    reads
      .slice(before)
      .some((read) => (read.input as { askId?: string }).askId === askId),
    'the open block reads its status again',
  );
  const old = present(window);
  assert.match(textOf(old), /Superseded/);
  noControls(old);

  const later = present(window, laterAskId);
  assert.match(textOf(later), /Ship the migration today\?/);
  assert.doesNotMatch(textOf(later), /1\/1/);
  assert.equal(choices(later).length, 2);
});

test('a refused send keeps the picks and lets the reader send again', async () => {
  const { ask, window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);
  const block = present(window);
  ask.answerWith(() => {
    throw {
      code: 'unavailable',
      message: 'The Thread did not take the answers.',
    };
  });

  await fillAll(window, block);
  await press(block, 'Send');
  await settle(50);

  const status = block.querySelector('[role="status"]');
  assert.notEqual(status, null, 'the failure is announced');
  assert.equal(textOf(status as Element).trim(), 'Could not send. Try again.');
  assert.doesNotMatch(textOf(block), /Answered/);
  assert.equal(freeAnswer(block)?.value, 'Wait for me');
  assert.equal(button(block, 'Send')?.disabled, false);

  await press(block, 'Back');
  assert.equal(checked(block, 'Single choice'), 'true');
  assert.equal(checked(block, 'Free answer'), 'true');
  await press(block, 'Next');

  ask.answerWith((input) => ({ state: 'answered', answers: input.answers }));
  await press(block, 'Send');
  await settle(50);

  const sent = window.received('threads.ask/v1.answer');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]?.input, { askId, answers: sentAnswers });
  assert.match(textOf(present(window)), /Answered/);
});

test('an answer written elsewhere arrives live: the block shows it, and chat draws no generic block for it', async () => {
  const { ask, window } = await open({ [askId]: { state: 'pending' } });
  await deliver(window, [accepted, asked]);
  assert.notEqual(button(present(window), 'Next'), null);

  const answers = [
    { id: 'who', options: ['Any thread'] },
    { id: 'scope', options: ['Free answer'] },
    { id: 'wait', options: ['Stop and wait'] },
  ];
  ask.statuses[askId] = { state: 'answered', answers };
  await live(window, row('threads.answered/v1', { askId, answers }, 3));

  const block = present(window);
  const text = textOf(block);
  assert.match(text, /Answered/);
  assert.ok(text.includes('Any thread'));
  assert.ok(text.includes('Free answer'));
  assert.ok(text.includes('Stop and wait'));
  noControls(block);
  assert.equal(
    window.document.querySelector('[data-chat-block-id="event:3"]'),
    null,
    'the answered row is no generic block',
  );
  assert.equal(
    [...window.document.querySelectorAll('chat-block')].some((element) =>
      textOf(element).includes('threads.answered/v1'),
    ),
    false,
  );
});
