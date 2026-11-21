// `chat.views/v1.registerInputRenderer` (1.2.0, bundle isolation 5(a), T5.2)
// in a real window, with made-up registrants (`support/renderers.ts`): every
// prompt of a registered source is drawn by the registered element with a
// `view` the chat keeps current; a bundle's instructions are keyed by its id;
// the registration wins over a `chat.delegated-input/v1` block renderer (O8);
// arrival and departure redraw the transcript at once; a `user` prompt is
// never drawn by an element.
// (The DOM-free registration checks are in `tests/views.test.ts`.)

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { ChatInputView } from '../../src/contracts/index.js';
import {
  projectId,
  snapshot,
  threadEvent,
  threadId,
  threadRecord,
  threadUrl,
} from './support/fences.js';
import {
  assertReady,
  choose,
  DELEGATED_ELEMENT,
  INPUT_ELEMENT,
  type ProbeElement,
  probeElements,
  rendererProbe,
  TOGGLE_INPUT_ELEMENT,
} from './support/renderers.js';
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

const host = {
  'runtime.threads/v1.thread': (input: unknown) =>
    threadRecord(typeof input === 'string' ? input : threadId),
  'runtime.threads/v1.queue': () => ({
    revision: 1,
    paused: false,
    stopping: false,
    items: [],
  }),
};

/** Opens the Thread with the probe, answering its watch with `events`. */
const openWith = async (
  probe: Probe,
  events: readonly unknown[],
): Promise<ChatWindow> => {
  opened = await openChatWindow({ url: threadUrl(threadId), host, probe });
  await settle(50);
  snapshot(opened, events);
  await settle(200);
  return opened;
};

const terminalPromptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parentPromptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const probePromptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherPromptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userPromptId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const parentThreadId = '55555555-5555-4555-8555-555555555555';
const terminalId = 'terminal-3f8a';

/** A background terminal result, framed as the host frames it. */
const terminalText = [
  '# Background terminal result',
  '',
  `Terminal: ${terminalId}`,
  'Originating prompt: prompt-9',
  'Command: npm test',
  'Exit code: 0',
  'Reason: exited',
  'Duration: 1940 ms',
  '',
  '## Standard output (last 12000 characters)',
  '',
  'ok',
  '',
  '## Standard error (last 12000 characters)',
  '',
].join('\n');

const accepted = (
  sequence: number,
  prompt: string,
  text: string,
  source: Readonly<Record<string, unknown>>,
) => threadEvent(sequence, { type: 'prompt.accepted', text, source }, prompt);

const fromTerminal = accepted(1, terminalPromptId, terminalText, {
  kind: 'terminal',
  terminalId,
});
const fromParent = accepted(2, parentPromptId, 'Fix the parser first.', {
  kind: 'parent',
  threadId: parentThreadId,
});
const fromProbe = accepted(3, probePromptId, 'Follow the probe workflow.', {
  kind: 'bundle',
  bundleId: 'probe',
  reason: 'probe-workflow',
});
const fromOther = accepted(4, otherPromptId, 'Follow the other workflow.', {
  kind: 'bundle',
  bundleId: 'other',
  reason: 'other-workflow',
});
const fromUser = accepted(5, userPromptId, 'Thanks, go on.', { kind: 'user' });

const transcriptText = (window: ChatWindow): string =>
  window.document.querySelector('[data-lexical-editor]')?.textContent ?? '';

/**
 * Whether the transcript holds the terminal-result block the chat drew of its
 * own until bundle isolation 5(b) change 4; `terminal` draws it now, so the
 * chat never does. A boolean, so a failure does not print a whole element.
 */
const terminalBlock = (window: ChatWindow): boolean =>
  window.document.querySelector('button[aria-label^="Toggle background"]') !==
  null;

/** The chat's plain text block of the terminal prompt: the host's frame, as text. */
const terminalPlainText = (window: ChatWindow): boolean =>
  /Background terminal result/.test(transcriptText(window)) &&
  /Command: npm test/.test(transcriptText(window));

/** The chat's own block of another Thread's instruction. */
const delegatedBlock = (window: ChatWindow) =>
  window.document.querySelector('[aria-label^="Toggle instruction from"]');

const inputView = (element: ProbeElement | undefined): ChatInputView => {
  assert.ok(element, 'the element is drawn');
  const view = element.view as ChatInputView | undefined;
  assert.ok(view, 'the element has a view');
  return view;
};

const viewOf = (window: ChatWindow, prompt: string) =>
  probeElements(window.document, INPUT_ELEMENT).find(
    (element) =>
      (element.view as ChatInputView | undefined)?.promptId === prompt,
  );

/** Presses Enter where the caret is, after a click put it on `target`'s block. */
const enterOn = async (window: ChatWindow, target: HTMLElement) => {
  target.click();
  await settle();
  const root = window.document.querySelector<HTMLElement>(
    '[data-lexical-editor]',
  );
  assert.ok(root, 'the transcript is drawn');
  root.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle(100);
};

describe('T5.2 a registered input element draws the prompts of its source', () => {
  test('a terminal prompt is one element whose view holds the ids, the source and the log’s text, in place of the chat’s block', async () => {
    const { probe, state } = rendererProbe({
      inputs: [{ source: 'terminal', elementTag: INPUT_ELEMENT }],
    });
    const window = await openWith(probe, [fromTerminal]);
    assertReady(state);

    const elements = probeElements(window.document, INPUT_ELEMENT);
    assert.equal(elements.length, 1);
    const view = inputView(elements[0]);
    assert.equal(view.projectId, projectId);
    assert.equal(view.threadId, threadId);
    assert.equal(view.promptId, terminalPromptId);
    assert.equal(view.source.kind, 'terminal');
    assert.equal(view.source.terminalId, terminalId);
    assert.equal(view.text, terminalText);
    assert.equal(view.chosen, null);
    assert.equal(view.focused, false);
    // The view was set before the element connected.
    const connected = state.connected.find(
      ({ element }) => element === elements[0],
    );
    assert.equal(
      (connected?.view as ChatInputView | undefined)?.promptId,
      terminalPromptId,
    );
    assert.equal(terminalBlock(window), false);
  });

  test('bundle:probe draws the instructions of bundle probe and leaves those of bundle other to the chat', async () => {
    const { probe, state } = rendererProbe({
      inputs: [{ source: 'bundle:probe', elementTag: INPUT_ELEMENT }],
    });
    const window = await openWith(probe, [fromProbe, fromOther]);
    assertReady(state);

    const elements = probeElements(window.document, INPUT_ELEMENT);
    assert.equal(elements.length, 1);
    const view = inputView(elements[0]);
    assert.equal(view.promptId, probePromptId);
    assert.equal(view.source.kind, 'bundle');
    assert.equal(view.source.bundleId, 'probe');
    assert.equal(view.source.reason, 'probe-workflow');
    assert.equal(view.text, 'Follow the probe workflow.');
    assert.match(transcriptText(window), /Follow the other workflow\./);
  });

  test('parent draws the parent Thread’s instruction even while a chat.delegated-input/v1 renderer is registered (O8)', async () => {
    const { probe, state } = rendererProbe({
      inputs: [{ source: 'parent', elementTag: INPUT_ELEMENT }],
      delegated: true,
    });
    const window = await openWith(probe, [fromParent]);
    assertReady(state);

    const view = inputView(viewOf(window, parentPromptId));
    assert.equal(view.source.kind, 'parent');
    assert.equal(view.source.threadId, parentThreadId);
    assert.equal(view.text, 'Fix the parser first.');
    assert.deepEqual(probeElements(window.document, DELEGATED_ELEMENT), []);
    assert.equal(delegatedBlock(window), null);
  });

  test('registrations made while the prompts are shown redraw them at once, and disposing them brings the chat’s drawing back', async () => {
    const { probe, state } = rendererProbe();
    const window = await openWith(probe, [
      fromTerminal,
      fromParent,
      fromProbe,
      fromUser,
    ]);
    assertReady(state);
    // Unregistered, a terminal prompt is the chat's plain text block (5(b)
    // change 4), not the result block it drew of its own.
    assert.equal(terminalBlock(window), false);
    assert.equal(terminalPlainText(window), true);
    assert.notEqual(delegatedBlock(window), null);
    assert.match(transcriptText(window), /Follow the probe workflow\./);
    assert.deepEqual(probeElements(window.document, INPUT_ELEMENT), []);

    for (const source of ['terminal', 'parent', 'bundle:probe'])
      state.registerInput({ source, elementTag: INPUT_ELEMENT });
    await settle(200);
    assertReady(state);
    assert.equal(probeElements(window.document, INPUT_ELEMENT).length, 3);
    for (const prompt of [terminalPromptId, parentPromptId, probePromptId])
      assert.ok(viewOf(window, prompt), `the element draws ${prompt}`);
    assert.equal(terminalBlock(window), false);
    assert.equal(delegatedBlock(window), null);
    assert.doesNotMatch(transcriptText(window), /Follow the probe workflow\./);
    const drawn = probeElements(window.document, INPUT_ELEMENT);

    for (const registration of state.inputs.values()) registration.dispose();
    await settle(200);
    assert.deepEqual(probeElements(window.document, INPUT_ELEMENT), []);
    for (const element of drawn)
      assert.ok(state.disposed.includes(element), 'the element was disposed');
    assert.equal(terminalBlock(window), false);
    assert.equal(terminalPlainText(window), true);
    assert.notEqual(delegatedBlock(window), null);
    assert.match(transcriptText(window), /Follow the probe workflow\./);
  });

  test('chat-block-chosen from an input element changes its view’s choice and no other', async () => {
    const { probe, state } = rendererProbe({
      inputs: [
        { source: 'terminal', elementTag: INPUT_ELEMENT },
        { source: 'parent', elementTag: INPUT_ELEMENT },
      ],
    });
    const window = await openWith(probe, [fromTerminal, fromParent]);
    assertReady(state);
    const terminal = viewOf(window, terminalPromptId);
    const parent = viewOf(window, parentPromptId);
    assert.ok(terminal && parent);
    const escaped: Event[] = [];
    window.document.addEventListener('chat-block-chosen', (event) =>
      escaped.push(event),
    );

    choose(terminal, true);
    await settle(100);
    assert.equal(inputView(terminal).chosen, true);
    assert.equal(inputView(parent).chosen, null);
    choose(terminal, false);
    await settle(100);
    assert.equal(inputView(terminal).chosen, false);
    assert.equal(inputView(parent).chosen, null);
    assert.deepEqual(escaped, []);
  });

  test('a user prompt is never drawn by an element', async () => {
    const { probe, state } = rendererProbe({
      inputs: [
        { source: 'terminal', elementTag: INPUT_ELEMENT },
        { source: 'parent', elementTag: INPUT_ELEMENT },
        { source: 'bundle:probe', elementTag: INPUT_ELEMENT },
      ],
    });
    const window = await openWith(probe, [fromUser, fromTerminal]);
    assertReady(state);

    assert.equal(viewOf(window, userPromptId), undefined);
    assert.ok(viewOf(window, terminalPromptId), 'the terminal prompt is drawn');
    assert.match(transcriptText(window), /Thanks, go on\./);
  });

  test('the toggle key on an input element with toggle() calls it, and its answer is the choice (O2)', async () => {
    const { probe, state } = rendererProbe({
      inputs: [{ source: 'terminal', elementTag: TOGGLE_INPUT_ELEMENT }],
    });
    const window = await openWith(probe, [fromTerminal]);
    assertReady(state);
    const [element] = probeElements(window.document, TOGGLE_INPUT_ELEMENT);
    assert.ok(element, 'the element is drawn');
    assert.equal(inputView(element).chosen, null);

    // The element shows itself open, so it folds; the generic answer would open.
    await enterOn(window, element);
    assert.deepEqual(state.toggled, [element]);
    assert.equal(inputView(element).chosen, false);
  });

  test('the toggle key on an input element without toggle() sets the generic answer: the opposite of a block folded once settled', async () => {
    const { probe, state } = rendererProbe({
      inputs: [{ source: 'terminal', elementTag: INPUT_ELEMENT }],
    });
    const window = await openWith(probe, [fromTerminal]);
    assertReady(state);
    const element = viewOf(window, terminalPromptId);
    assert.ok(element, 'the element is drawn');
    assert.equal(inputView(element).chosen, null);

    await enterOn(window, element);
    assert.equal(inputView(element).chosen, true);
    await enterOn(window, element);
    assert.equal(inputView(element).chosen, false);
    assert.deepEqual(state.toggled, []);
  });
});
