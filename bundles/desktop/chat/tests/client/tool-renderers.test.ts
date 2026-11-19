// `chat.views/v1.registerToolRenderer` (1.2.0, bundle isolation 5(a)) in a real
// window, with made-up registrants (`support/renderers.ts`):
// - T5.1: a registered element draws each call of its tool with a `view` the
//   chat keeps current, one element per call for the call's life; `standalone`
//   takes the call out of the activity group; `openByDefault` opens the
//   generic row; a failed registration leaves the chat's drawing; a
//   registration's arrival and departure redraw the transcript at once.
// - T5.3: `chat-block-chosen` from inside an element is that block's choice,
//   and the toggle key reaches the element's `toggle()` when it defines one,
//   else sets the generic answer; standalone and inside an activity group.
// - T5.4: an unregistered tool is the generic row inside the activity group,
//   closed.
// (The DOM-free registration checks are in `tests/views.test.ts`.)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';

import type { ChatToolView } from '../../src/contracts/index.js';
import {
  projectId,
  promptId,
  push,
  snapshot,
  threadEvent,
  threadId,
  threadRecord,
  threadUrl,
} from './support/fences.js';
import {
  assertReady,
  choose,
  errorCodes,
  type ProbeElement,
  probeElements,
  rendererProbe,
  TOGGLE_TOOL_ELEMENT,
  TOOL_ELEMENT,
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
  await settle(150);
  return opened;
};

const call = (id: string, name: string) => ({
  id,
  name,
  index: 0,
  payload: { path: `${id}.ts` },
});

const asked = threadEvent(1, {
  type: 'prompt.accepted',
  text: 'Run the probe',
  source: { kind: 'user' },
});
const started = (sequence: number, id: string, name = 'probe_tool') =>
  threadEvent(sequence, { type: 'tool.started', call: call(id, name) });
const finished = (sequence: number, id: string, name = 'probe_tool') =>
  threadEvent(sequence, {
    type: 'tool.finished',
    call: call(id, name),
    record: { output: `${id} output` },
  });
const failed = (sequence: number, id: string, name = 'probe_tool') =>
  threadEvent(sequence, {
    type: 'tool.failed',
    call: call(id, name),
    error: {
      message: 'The probe failed.',
      data: { code: 'probe_failed' },
      cause: { message: 'Rate limited', data: { code: 'rate_limit_error' } },
    },
  });
const thought = (sequence: number, delta: string) =>
  threadEvent(sequence, { type: 'reasoning.delta', delta });
const done = (sequence: number) =>
  threadEvent(sequence, {
    type: 'prompt.finished',
    status: 'completed',
    text: '',
    source: { kind: 'user' },
  });

/** A call that ran and finished, at `sequence` and the one after. */
const ran = (sequence: number, id: string, name = 'probe_tool') => [
  started(sequence, id, name),
  finished(sequence + 1, id, name),
];

/** The transcript's top-level blocks. */
const blocks = (window: ChatWindow): Element[] => [
  ...(window.document.querySelector('[data-lexical-editor]')?.children ?? []),
];

/** The activity summaries of the transcript: the blocks that read "… called N tool(s)". */
const summaries = (window: ChatWindow): Element[] =>
  blocks(window).filter((block) =>
    /^\s*(Thought .*, called|Called) \d+ tools?/.test(block.textContent ?? ''),
  );

/** Opens a summary as the reader does, by its header. */
const openSummary = async (summary: Element): Promise<void> => {
  summary
    .querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
    ?.click();
  await settle(100);
};

const transcriptText = (window: ChatWindow): string =>
  window.document.querySelector('[data-lexical-editor]')?.textContent ?? '';

const toolView = (element: ProbeElement | undefined): ChatToolView => {
  assert.ok(element, 'the element is drawn');
  const view = element.view as ChatToolView | undefined;
  assert.ok(view, 'the element has a view');
  return view;
};

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

const probeTool = { toolName: 'probe_tool', elementTag: TOOL_ELEMENT };

describe('T5.1 a registered tool element draws each call', () => {
  test('each call is one element whose view holds the ids, the call and no choice yet', async () => {
    const { probe, state } = rendererProbe({ tools: [probeTool] });
    const window = await openWith(probe, [
      asked,
      started(2, 'c1'),
      started(3, 'c2'),
    ]);
    assertReady(state);

    const elements = probeElements(window.document, TOOL_ELEMENT);
    assert.equal(elements.length, 2);
    const first = toolView(elements[0]);
    assert.equal(first.projectId, projectId);
    assert.equal(first.threadId, threadId);
    assert.equal(first.promptId, promptId);
    assert.equal(first.key, `${promptId}/c1`);
    assert.equal(first.name, 'probe_tool');
    assert.equal(first.args, JSON.stringify({ path: 'c1.ts' }));
    assert.equal(first.status, 'running');
    assert.equal(first.result, undefined);
    assert.equal(first.error, undefined);
    assert.equal(first.chosen, null);
    assert.equal(first.focused, false);
    assert.equal(toolView(elements[1]).key, `${promptId}/c2`);
    // The view was set before the element connected.
    const connected = state.connected.find(
      ({ element }) => element === elements[0],
    );
    assert.equal((connected?.view as ChatToolView | undefined)?.key, first.key);
    // The chat's generic row does not draw the call too.
    assert.doesNotMatch(transcriptText(window), /Calling probe tool/);
  });

  test('a finished call updates the same element; a failed call carries its whole error; keys stay', async () => {
    const { probe, state } = rendererProbe({ tools: [probeTool] });
    const window = await openWith(probe, [asked, started(2, 'c1')]);
    assertReady(state);
    const [element] = probeElements(window.document, TOOL_ELEMENT);
    assert.ok(element);

    push(window, finished(3, 'c1'));
    await settle(150);
    assert.deepEqual(probeElements(window.document, TOOL_ELEMENT), [element]);
    assert.equal(state.created.length, 1);
    const done1 = toolView(element);
    assert.equal(done1.status, 'finished');
    assert.equal(done1.result, 'c1 output');
    assert.equal(done1.key, `${promptId}/c1`);

    push(window, started(4, 'c2'));
    await settle(150);
    push(window, failed(5, 'c2'));
    await settle(150);
    const elements = probeElements(window.document, TOOL_ELEMENT);
    assert.equal(elements.length, 2);
    assert.equal(elements[0], element);
    const failure = toolView(elements[1]);
    assert.equal(failure.key, `${promptId}/c2`);
    assert.notEqual(failure.key, toolView(element).key);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.error?.code, 'probe_failed');
    assert.equal(failure.error?.message, 'The probe failed.');
    assert.equal(failure.error?.causes.length, 1);
    assert.equal(failure.error?.causes[0]?.code, 'rate_limit_error');
    assert.equal(failure.error?.causes[0]?.message, 'Rate limited');
    // Every view a call's element was given carries one key.
    for (const view of element.views)
      assert.equal((view as ChatToolView).key, `${promptId}/c1`);
  });

  test('without standalone the element draws inside the activity summary once it is opened', async () => {
    const { probe, state } = rendererProbe({ tools: [probeTool] });
    const window = await openWith(probe, [
      asked,
      thought(2, 'inspect'),
      ...ran(3, 'c1', 'probe_other'),
      ...ran(5, 'c2'),
      thought(7, 'verify'),
      ...ran(8, 'c3', 'probe_other'),
      done(10),
    ]);
    assertReady(state);

    const [summary] = summaries(window);
    assert.ok(
      summary,
      blocks(window)
        .map((b) => b.textContent)
        .join(' | '),
    );
    assert.equal(summaries(window).length, 1);
    assert.deepEqual(probeElements(window.document, TOOL_ELEMENT), []);
    await openSummary(summary);
    const [element] = probeElements(window.document, TOOL_ELEMENT);
    assert.ok(element, 'the opened summary draws the element');
    assert.ok(summaries(window)[0]?.contains(element));
  });

  test('with standalone the element is a block of its own, outside the summaries', async () => {
    const { probe, state } = rendererProbe({
      tools: [{ ...probeTool, standalone: true }],
    });
    const window = await openWith(probe, [
      asked,
      thought(2, 'inspect'),
      ...ran(3, 'c1', 'probe_other'),
      ...ran(5, 'c2'),
      thought(7, 'verify'),
      ...ran(8, 'c3', 'probe_other'),
      done(10),
    ]);
    assertReady(state);

    const [element] = probeElements(window.document, TOOL_ELEMENT);
    assert.ok(element, 'the standalone call is drawn without opening anything');
    assert.equal(summaries(window).length, 2);
    for (const summary of summaries(window))
      assert.ok(!summary.contains(element));
    // In log order: summary, the call, summary.
    const order = blocks(window).filter(
      (block) => summaries(window).includes(block) || block.contains(element),
    );
    assert.equal(order.length, 3);
    assert.ok(order[1]?.contains(element));
  });

  test('openByDefault opens the generic row of a settled call; without it the row is folded', async () => {
    const events = [asked, ...ran(2, 'c1', 'probe_view'), done(4)];
    const flagged = rendererProbe({
      tools: [{ toolName: 'probe_view', openByDefault: true }],
    });
    const window = await openWith(flagged.probe, events);
    assertReady(flagged.state);
    assert.match(transcriptText(window), /Called probe view/);
    assert.ok(
      transcriptText(window).includes(JSON.stringify({ path: 'c1.ts' })),
      'the arguments show without a click',
    );
    await opened?.close();

    const plain = rendererProbe({
      tools: [{ toolName: 'probe_unrelated', standalone: true }],
    });
    const again = await openWith(plain.probe, events);
    assertReady(plain.state);
    assert.match(transcriptText(again), /Called probe view/);
    assert.ok(
      !transcriptText(again).includes(JSON.stringify({ path: 'c1.ts' })),
      'the row is folded',
    );
  });

  test('a second registration and an undefined element throw in the probe, and the transcript keeps the chat’s drawing', async () => {
    const { probe, state } = rendererProbe({
      tools: [
        probeTool,
        { toolName: 'probe_tool', elementTag: TOGGLE_TOOL_ELEMENT },
        { toolName: 'probe_missing', elementTag: 'probe-missing' },
      ],
    });
    const window = await openWith(probe, [
      asked,
      started(2, 'c1'),
      started(3, 'c2', 'probe_missing'),
    ]);

    assert.ok(state.views, 'the probe activated');
    assert.deepEqual(errorCodes(state), [
      'registration_conflict',
      'invalid_input',
    ]);
    // The first registration holds its name.
    assert.equal(probeElements(window.document, TOOL_ELEMENT).length, 1);
    assert.equal(probeElements(window.document, TOGGLE_TOOL_ELEMENT).length, 0);
    // The failed one left the generic row.
    assert.match(transcriptText(window), /Calling probe missing/);
  });

  test('a registration made while the calls are shown redraws them at once, and disposing it brings the generic row back', async () => {
    const { probe, state } = rendererProbe();
    const window = await openWith(probe, [asked, started(2, 'c1')]);
    assertReady(state);
    assert.match(transcriptText(window), /Calling probe tool/);
    assert.deepEqual(probeElements(window.document, TOOL_ELEMENT), []);

    state.registerTool(probeTool);
    await settle(150);
    assertReady(state);
    const [element] = probeElements(window.document, TOOL_ELEMENT);
    assert.ok(element, 'the call is redrawn by the element');
    assert.equal(toolView(element).key, `${promptId}/c1`);
    assert.doesNotMatch(transcriptText(window), /Calling probe tool/);

    state.tools.get('probe_tool')?.dispose();
    await settle(150);
    assert.deepEqual(probeElements(window.document, TOOL_ELEMENT), []);
    assert.ok(state.disposed.includes(element), 'the element was disposed');
    assert.match(transcriptText(window), /Calling probe tool/);
  });

  test('a registration of `load_skill` with no element draws its call with the generic row, not the skill block; disposing it brings the skill block back', async () => {
    const { probe, state } = rendererProbe({
      tools: [{ toolName: 'load_skill' }],
    });
    const window = await openWith(probe, [
      asked,
      started(2, 'c1', 'load_skill'),
    ]);
    assertReady(state);
    const skillNames = () =>
      window.document.querySelectorAll('[data-slot="skill-name"]').length;
    assert.equal(skillNames(), 0, 'the built-in skill block is not drawn');
    assert.doesNotMatch(transcriptText(window), /Loading skill/);
    assert.match(transcriptText(window), /Calling load skill/);

    state.tools.get('load_skill')?.dispose();
    await settle(150);
    assert.equal(skillNames(), 1, 'the built-in skill block is back');
    assert.match(transcriptText(window), /Loading skill/);
    assert.doesNotMatch(transcriptText(window), /Calling load skill/);
  });
});

describe('T5.3 the reader’s choice on an element block', () => {
  test('chat-block-chosen from inside one element sets that block’s choice only, and stops at its frame', async () => {
    const { probe, state } = rendererProbe({ tools: [probeTool] });
    const window = await openWith(probe, [
      asked,
      started(2, 'c1'),
      started(3, 'c2'),
    ]);
    assertReady(state);
    const [first, second] = probeElements(window.document, TOOL_ELEMENT);
    assert.ok(first && second);
    const escaped: Event[] = [];
    window.document.addEventListener('chat-block-chosen', (event) =>
      escaped.push(event),
    );

    choose(first, true);
    await settle(100);
    assert.equal(toolView(first).chosen, true);
    assert.equal(toolView(second).chosen, null);

    choose(first, false);
    await settle(100);
    assert.equal(toolView(first).chosen, false);
    assert.equal(toolView(second).chosen, null);
    assert.deepEqual(escaped, []);
    // The same elements, not new ones.
    assert.deepEqual(probeElements(window.document, TOOL_ELEMENT), [
      first,
      second,
    ]);
  });

  test('the toggle key on a standalone element without toggle() sets the opposite of the generic answer', async () => {
    const { probe, state } = rendererProbe({ tools: [probeTool] });
    const window = await openWith(probe, [asked, ...ran(2, 'c1'), done(4)]);
    assertReady(state);
    const [element] = probeElements(window.document, TOOL_ELEMENT);
    assert.ok(element);
    assert.equal(toolView(element).chosen, null);

    // Settled and not open by default: the generic block shows closed.
    await enterOn(window, element);
    assert.equal(toolView(element).chosen, true);
    await enterOn(window, element);
    assert.equal(toolView(element).chosen, false);
  });

  test('the toggle key on a standalone element with toggle() calls it, and its answer is the choice', async () => {
    const { probe, state } = rendererProbe({
      tools: [{ toolName: 'probe_tool', elementTag: TOGGLE_TOOL_ELEMENT }],
    });
    const window = await openWith(probe, [asked, ...ran(2, 'c1'), done(4)]);
    assertReady(state);
    const [element] = probeElements(window.document, TOGGLE_TOOL_ELEMENT);
    assert.ok(element);

    // The element shows itself open, so it folds; the generic answer would open.
    await enterOn(window, element);
    assert.deepEqual(state.toggled, [element]);
    assert.equal(toolView(element).chosen, false);
  });

  test('the toggle key on an element inside an activity group calls its toggle()', async () => {
    const { probe, state } = rendererProbe({
      tools: [{ toolName: 'probe_tool', elementTag: TOGGLE_TOOL_ELEMENT }],
    });
    const window = await openWith(probe, [
      asked,
      thought(2, 'inspect'),
      ...ran(3, 'c1', 'probe_other'),
      ...ran(5, 'c2'),
      done(7),
    ]);
    assertReady(state);
    const [summary] = summaries(window);
    assert.ok(summary);
    await openSummary(summary);
    const [element] = probeElements(window.document, TOGGLE_TOOL_ELEMENT);
    assert.ok(element, 'the opened summary draws the element');

    await enterOn(window, element);
    assert.deepEqual(state.toggled, [element]);
    assert.equal(toolView(element).chosen, false);
  });

  test('the toggle key on an element without toggle() inside an activity group sets the generic answer', async () => {
    const { probe, state } = rendererProbe({ tools: [probeTool] });
    const window = await openWith(probe, [
      asked,
      thought(2, 'inspect'),
      ...ran(3, 'c1', 'probe_other'),
      ...ran(5, 'c2'),
      done(7),
    ]);
    assertReady(state);
    const [summary] = summaries(window);
    assert.ok(summary);
    await openSummary(summary);
    const [element] = probeElements(window.document, TOOL_ELEMENT);
    assert.ok(element, 'the opened summary draws the element');
    assert.equal(toolView(element).chosen, null);

    await enterOn(window, element);
    assert.equal(toolView(element).chosen, true);
  });
});

describe('T5.4 an unregistered tool', () => {
  test('in a settled burst of more than one step is the generic row inside the activity summary, closed', async () => {
    const { probe, state } = rendererProbe({ tools: [probeTool] });
    const window = await openWith(probe, [
      asked,
      thought(2, 'inspect'),
      ...ran(3, 'c1', 'probe_unknown'),
      done(5),
    ]);
    assertReady(state);

    const [summary] = summaries(window);
    assert.ok(
      summary,
      blocks(window)
        .map((b) => b.textContent)
        .join(' | '),
    );
    assert.doesNotMatch(transcriptText(window), /Called probe unknown/);
    await openSummary(summary);
    const shown = summaries(window)[0];
    assert.match(shown?.textContent ?? '', /Called probe unknown/);
    assert.ok(
      !(shown?.textContent ?? '').includes(JSON.stringify({ path: 'c1.ts' })),
      'the row is closed',
    );
  });

  // 5(b) change 1: `files` draws `edit`, `write` and `view-image`; the chat
  // has no drawing of its own left for them.
  test('edit, write and view-image are the generic row inside the activity summary, closed, with no diff block', async () => {
    const { probe, state } = rendererProbe({ tools: [probeTool] });
    const window = await openWith(probe, [
      asked,
      thought(2, 'inspect'),
      ...ran(3, 'c1', 'edit'),
      ...ran(5, 'c2', 'write'),
      ...ran(7, 'c3', 'view-image'),
      done(9),
    ]);
    assertReady(state);

    assert.equal(
      window.document.querySelectorAll('[data-slot="edit-tool"]').length,
      0,
      'no diff block is drawn',
    );
    assert.equal(
      summaries(window).length,
      1,
      blocks(window)
        .map((b) => b.textContent)
        .join(' | '),
    );
    const [summary] = summaries(window);
    assert.ok(summary);
    assert.match(summary.textContent ?? '', /called 3 tools/);
    await openSummary(summary);
    const shown = summaries(window)[0]?.textContent ?? '';
    assert.match(shown, /Called edit/);
    assert.match(shown, /Called write/);
    for (const id of ['c1', 'c2', 'c3'])
      assert.ok(
        !shown.includes(JSON.stringify({ path: `${id}.ts` })),
        `the row of ${id} is closed`,
      );
  });
});

test('the chat manifest is 1.10.1 on platform ^1.10.0 and provides chat.views/v1@1.2.0', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/desktop/chat/manifest.json', 'utf8'),
  ) as {
    readonly version: string;
    readonly engines: { readonly doric: string };
    readonly provides: readonly string[];
  };
  assert.equal(manifest.version, '1.10.1');
  assert.equal(manifest.engines.doric, '^1.10.0');
  assert.ok(
    manifest.provides.includes('chat.views/v1@1.2.0'),
    manifest.provides.join(', '),
  );
});
