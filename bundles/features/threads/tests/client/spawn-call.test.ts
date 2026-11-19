// The `threads-spawn-call` element (bundle isolation 5(b), change 3): the
// block of a `thread-spawn` call, moved from the chat's
// `components/organisms/conversation/nodes/thread-spawn-node.tsx` and
// registered through `chat.views/v1` 1.2.0.
// - AC5.3: the drawing's cases, moved from the chat's
//   `tests/client/thread-spawn.test.ts`, mount the element alone with the
//   `view` the chat sets for the case's call (no chat window, no chat built
//   part) and keep their assertions on what the block draws. They select the
//   block by its `data-slot="thread-spawn"`, not by the chat's
//   `data-spawn-call-id`. The child's name comes from a fake
//   `runtime.records/v1`; the prompt is chat's `<chat-readonly-markdown>`,
//   created through a fake `ui/v1`.
// - `spawnOpenness` (moved from the chat's `tests/collapsible.test.ts`): open
//   while spawning and when failed, folded once spawned; the reader's choice
//   stands over it.
// - O2: the element's `toggle()` reports the opposite of what the block
//   shows; a failed spawn shows open.
// - `:1038`: the client part defines the tag and registers `thread-spawn`,
//   standalone, in a `whenAvailable` callback of its own beside the delegated
//   input's; its cleanup disposes it.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { errorInfo } from 'desktop/reads';
import { blockOpen } from 'desktop/ui/collapsible-block';

import type {
  ChatToolView,
  ToolRendererSpec,
} from '../../src/client/chat-contract.js';
import { assertToolNotice } from './support/notices.js';
import {
  installWindow,
  type MountedElement,
  mountElement,
  settle,
} from './support/render.js';
import { fakeServices } from './support/services.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const failedAt = '2026-01-01T00:00:03.000Z';

/** The child the spawn starts, as the workspace's records know it. */
const childId = '44444444-4444-4444-8444-444444444444';
const childPromptId = '55555555-5555-4555-8555-555555555555';
const childProjectId = '66666666-6666-4666-8666-666666666666';

const childRecord = {
  id: childId,
  name: 'Accent audit',
  projectId: childProjectId,
  parentThreadId: threadId,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** The `view` the chat sets on the element for one `thread-spawn` call. */
const callView = (input: {
  readonly status: ChatToolView['status'];
  readonly payload?: Readonly<Record<string, string>>;
  readonly result?: string;
  readonly error?: ChatToolView['error'];
  readonly chosen?: boolean | null;
}): ChatToolView => ({
  projectId,
  threadId,
  promptId,
  key: `${promptId}/call-1`,
  name: 'thread-spawn',
  args: JSON.stringify({
    prompt: 'Audit the contrast',
    ...(input.payload ?? {}),
  }),
  ...(input.result === undefined ? {} : { result: input.result }),
  ...(input.error === undefined ? {} : { error: input.error }),
  status: input.status,
  chosen: input.chosen ?? null,
  focused: false,
});

const spawnedResult = JSON.stringify({
  threadId: childId,
  promptId: childPromptId,
});

const spawning = (payload?: Readonly<Record<string, string>>) =>
  callView({
    status: 'running',
    ...(payload === undefined ? {} : { payload }),
  });
const spawned = (
  input: {
    readonly payload?: Readonly<Record<string, string>>;
    readonly chosen?: boolean | null;
  } = {},
) => callView({ status: 'finished', result: spawnedResult, ...input });
const failed = () =>
  callView({
    status: 'failed',
    error: errorInfo(
      { message: 'The child Thread could not be started.' },
      { at: failedAt },
    ),
  });

/** What the element's services were asked: Markdown created, paths navigated. */
interface ElementServices {
  readonly markdown: string[];
  readonly navigated: string[];
}

let mounted: MountedElement<ChatToolView> | undefined;
let records: (() => void) | undefined;

afterEach(() => {
  mounted?.cleanup();
  mounted = undefined;
  records?.();
  records = undefined;
});

/**
 * Serves `runtime.records/v1` holding the child to the threads client part,
 * by activating it as the platform does (no `chat.views/v1`, so nothing is
 * registered); the cleanup ends the activation.
 */
const withChildRecord = async (): Promise<void> => {
  installWindow();
  const { activate } = await import('../../src/client/index.js');
  const { services } = fakeServices({
    'ui/v1': {
      define: () => ({ dispose: () => undefined }),
      create: () => document.createElement('div'),
      dispose: () => undefined,
    },
    'runtime.records/v1': {
      thread: (id: string) => (id === childId ? childRecord : undefined),
      subscribe: () => ({ dispose: () => undefined }),
    },
  });
  const cleanup = activate({ services } as unknown as Parameters<
    typeof activate
  >[0]);
  records = () => {
    if (typeof cleanup === 'function') cleanup();
  };
};

/** Mounts `threads-spawn-call` alone with `view`, as the chat creates it. */
const mountSpawnCall = async (
  view: ChatToolView,
): Promise<MountedElement<ChatToolView> & ElementServices> => {
  installWindow();
  const { SPAWN_CALL_TAG, defineSpawnCallElement } = await import(
    '../../src/client/spawn-call.js'
  );
  const markdown: string[] = [];
  const navigated: string[] = [];
  const { services } = fakeServices({
    'ui/v1': {
      define: () => ({ dispose: () => undefined }),
      // Chat's read-only Markdown, as plain text the block holds.
      create: (tag: string, props?: { readonly text?: string }) => {
        assert.equal(tag, 'chat-readonly-markdown');
        markdown.push(props?.text ?? '');
        const element = document.createElement('div');
        element.setAttribute('data-slot', 'readonly-markdown');
        element.textContent = props?.text ?? '';
        return element;
      },
      dispose: () => undefined,
    },
    'navigation/v1': {
      navigate: (path: string) => {
        navigated.push(path);
      },
    },
  });
  mounted = await mountElement(SPAWN_CALL_TAG, defineSpawnCallElement(), {
    services,
    view,
  });
  return Object.assign(mounted, { markdown, navigated });
};

/** The spawn block the element draws. */
const blockOf = (element: HTMLElement): HTMLElement => {
  const block = element.querySelector<HTMLElement>(
    '[data-slot="thread-spawn"]',
  );
  assert.ok(block, 'the element draws the spawn block');
  return block;
};

/** The header's own toggle, which opens and closes the block. */
const toggleOf = (block: HTMLElement): HTMLElement | null =>
  block.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');

/** The header's note of the agent, model and effort the child runs with. */
const metaOf = (block: HTMLElement): HTMLElement | null =>
  block.querySelector<HTMLElement>('[data-slot="spawn-meta"]');

/** The element the header's label stands in: its verb and nothing beside it. */
const labelHolder = (block: HTMLElement): Element | null =>
  toggleOf(block)?.querySelector('span.font-normal')?.parentElement ?? null;

/** The link to the child Thread: a button titled with the child's id. */
const childLink = (block: HTMLElement): HTMLElement | null =>
  block.querySelector<HTMLElement>(`button[title="${childId}"]`);

const textOf = (element: HTMLElement): string => element.textContent ?? '';

describe('the thread-spawn block, mounted alone (AC5.3)', () => {
  test('a spawning call draws its own block, open, saying it is spawning', async () => {
    const call = await mountSpawnCall(spawning());
    const block = blockOf(call.element);

    assert.match(textOf(block), /Spawning/);
    // Open: the prompt the agent handed down is readable while the call runs,
    // as chat's read-only Markdown.
    assert.match(textOf(block), /Audit the contrast/);
    assert.deepEqual(call.markdown, ['Audit the contrast']);
    // No child exists yet, so the header names no Thread to open.
    assert.equal(block.querySelector('button[title]'), null);
    assert.doesNotMatch(textOf(call.element), /Called thread spawn/);
  });

  test('a finished spawn folds away, naming the Thread it started in its header', async () => {
    await withChildRecord();
    const call = await mountSpawnCall(spawned());
    const block = blockOf(call.element);

    assert.match(textOf(block), /Spawned/);
    // Folded: the prompt is the block's detail, and it is not drawn.
    assert.doesNotMatch(textOf(block), /Audit the contrast/);

    const link = childLink(block);
    assert.ok(link, 'the header links the child Thread');
    assert.match(textOf(link), /Accent audit/);
    // The child's name is part of the header line, not of the folded detail.
    assert.equal(link.closest('[data-slot="collapsible-content"]'), null);
  });

  test("opening a folded spawn by its header reports the reader's choice, and the next view opens it", async () => {
    const call = await mountSpawnCall(spawned());
    const block = blockOf(call.element);
    assert.doesNotMatch(textOf(block), /Audit the contrast/);

    toggleOf(block)?.click();
    await settle();
    assert.deepEqual(call.chosen, [true], 'the header reports chosen true');

    await call.setView(spawned({ chosen: true }));
    assert.match(textOf(blockOf(call.element)), /Audit the contrast/);
  });

  test('a spawn that failed is open with its error and names no Thread', async () => {
    const call = await mountSpawnCall(failed());
    const block = blockOf(call.element);

    assert.match(textOf(block), /failed/i);
    assert.match(textOf(block), /The child Thread could not be started\./);
    // Open: the prompt it was to hand down stays readable beside the error.
    assert.match(textOf(block), /Audit the contrast/);
    // The error notice's own "Copy details" button is not a Thread link.
    const threadLinks = [...block.querySelectorAll('button[title]')].filter(
      (button) => button.getAttribute('title') !== 'Copy details',
    );
    assert.equal(threadLinks.length, 0);
  });

  test('a spawning block updates in place once its child exists', async () => {
    await withChildRecord();
    const call = await mountSpawnCall(spawning());
    const element = call.element;
    const before = blockOf(element);
    assert.match(textOf(before), /Spawning/);

    await call.setView(spawned());

    // The element draws the settled call into the block it already drew, so
    // the reader's caret and their scroll stay where they were.
    assert.equal(blockOf(element), before);
    assert.equal(before.isConnected, true);
    assert.match(textOf(before), /Spawned/);
    assert.ok(childLink(before));
  });

  test('a finished spawn names the agent, model and effort of its child in the header', async () => {
    await withChildRecord();
    const call = await mountSpawnCall(
      spawned({
        payload: { agent: 'reviewer', model: 'gpt-5', effort: 'high' },
      }),
    );
    const block = blockOf(call.element);

    assert.equal(toggleOf(block)?.textContent, 'Spawned');
    assert.equal(metaOf(block)?.textContent, '· reviewer · gpt-5 · high');
    // The note is part of the header line, not of the folded detail.
    assert.equal(
      metaOf(block)?.closest('[data-slot="collapsible-content"]'),
      null,
    );
    // The header still names the child it started.
    const link = childLink(block);
    assert.ok(link);
    assert.match(textOf(link), /Accent audit/);
    // The note closes the header: what the work is first, how it runs after.
    assert.equal(link.nextElementSibling, metaOf(block));
    // Folded as before: the prompt is the detail, and it is not drawn.
    assert.doesNotMatch(textOf(block), /Audit the contrast/);
  });

  test('a spawning call names only the settings it carries', async () => {
    const call = await mountSpawnCall(
      spawning({ agent: 'reviewer', effort: 'high' }),
    );
    const block = blockOf(call.element);

    assert.equal(metaOf(block)?.textContent, '· reviewer · high');
    assert.equal(toggleOf(block)?.textContent, 'Spawning · reviewer · high');
    // Open while it runs: the prompt stays readable.
    assert.match(textOf(block), /Audit the contrast/);
  });

  test('a spawn that names no settings keeps its header to the verb alone', async () => {
    await withChildRecord();
    const finished = blockOf((await mountSpawnCall(spawned())).element);
    assert.equal(toggleOf(finished)?.textContent, 'Spawned');
    assert.equal(metaOf(finished), null);
    const holder = labelHolder(finished);
    assert.equal(holder?.children.length, 1);
    assert.equal(holder?.firstElementChild?.matches('span.font-normal'), true);

    const running = blockOf((await mountSpawnCall(spawning())).element);
    assert.equal(toggleOf(running)?.textContent, 'Spawning');
    assert.equal(metaOf(running), null);
    assert.equal(labelHolder(running)?.children.length, 1);
  });

  test("clicking the child's name opens its Thread", async () => {
    await withChildRecord();
    const call = await mountSpawnCall(spawned());

    childLink(blockOf(call.element))?.click();
    await settle();

    assert.deepEqual(call.navigated, [
      `/projects/${childProjectId}/threads/${childId}`,
    ]);
  });

  test('T-19 a spawn that failed shows the compact tool notice naming the call', async () => {
    const call = await mountSpawnCall(failed());

    await assertToolNotice(blockOf(call.element), {
      title: 'Tool failed',
      explanation: 'The child Thread could not be started.',
      tool: 'thread-spawn',
    });
  });
});

describe('spawnOpenness, the open rule of the thread-spawn block', () => {
  test('a thread-spawn block is open while it spawns and when it failed, and folded once it spawned', async () => {
    installWindow();
    const { spawnOpenness } = await import('../../src/client/spawn-call.js');

    assert.equal(blockOpen(null, spawnOpenness('running')), true);
    assert.equal(blockOpen(null, spawnOpenness('finished')), false);
    assert.equal(blockOpen(null, spawnOpenness('failed')), true);
  });

  test("the reader's choice on a thread-spawn block stands over its call", async () => {
    installWindow();
    const { spawnOpenness } = await import('../../src/client/spawn-call.js');

    assert.equal(blockOpen(true, spawnOpenness('running')), true);
    assert.equal(blockOpen(true, spawnOpenness('finished')), true);
    assert.equal(blockOpen(false, spawnOpenness('running')), false);
    assert.equal(blockOpen(false, spawnOpenness('failed')), false);
  });
});

describe('the toggle key on the thread-spawn block (O2)', () => {
  test('toggle() on a failed spawn, open on its own, reports chosen false', async () => {
    const call = await mountSpawnCall(failed());
    assert.equal(typeof call.element.toggle, 'function');

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [false]);
  });

  test('toggle() on a spawning call, open on its own, reports chosen false', async () => {
    const call = await mountSpawnCall(spawning());
    assert.equal(typeof call.element.toggle, 'function');

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [false]);
  });

  test('toggle() on a finished spawn, folded on its own, reports chosen true', async () => {
    const call = await mountSpawnCall(spawned());
    assert.equal(typeof call.element.toggle, 'function');

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [true]);
  });

  test("toggle() reports the opposite of the reader's choice the view carries", async () => {
    const call = await mountSpawnCall(spawned({ chosen: true }));

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [false]);
  });
});

/** What the threads client part's activation asked of `chat.views/v1`. */
interface Activation {
  readonly defined: readonly string[];
  readonly registered: readonly ToolRendererSpec[];
  /** The block types the delegated-input renderer was registered for. */
  readonly renderers: readonly string[];
  /** What was disposed, by tool name or block type. */
  readonly disposed: readonly string[];
  /** What the `whenAvailable` callbacks threw, as the platform records it. */
  readonly failures: readonly unknown[];
  readonly cleanup: () => void;
}

/** Activates the threads client part over fakes, `chat.views/v1` served or not. */
const activateWith = async (input: {
  readonly views: boolean;
  /** `registerToolRenderer` refuses, as for a name another bundle holds. */
  readonly refuseTool?: boolean;
}): Promise<Activation> => {
  installWindow();
  const { activate } = await import('../../src/client/index.js');
  const defined: string[] = [];
  const registered: ToolRendererSpec[] = [];
  const renderers: string[] = [];
  const disposed: string[] = [];
  const { services, failures } = fakeServices({
    'ui/v1': {
      define: (tag: string) => {
        defined.push(tag);
        return { dispose: () => undefined };
      },
    },
    ...(input.views
      ? {
          'chat.views/v1': {
            registerRenderer: (spec: { readonly blockType: string }) => {
              renderers.push(spec.blockType);
              return { dispose: () => disposed.push(spec.blockType) };
            },
            registerProjector: () => ({ dispose: () => undefined }),
            registerToolRenderer: (spec: ToolRendererSpec) => {
              if (input.refuseTool === true)
                throw new Error(`${spec.toolName} is already registered.`);
              registered.push(spec);
              return { dispose: () => disposed.push(spec.toolName) };
            },
            registerInputRenderer: () => ({ dispose: () => undefined }),
          },
        }
      : {}),
  });
  const cleanup = activate({ services } as unknown as Parameters<
    typeof activate
  >[0]);
  return {
    defined,
    registered,
    renderers,
    disposed,
    failures,
    cleanup: () => {
      if (typeof cleanup === 'function') cleanup();
    },
  };
};

/** A spec's facts, an absent flag read as its default `false` (the contract's rule). */
const facts = (spec: ToolRendererSpec) => ({
  toolName: spec.toolName,
  elementTag: spec.elementTag,
  standalone: spec.standalone ?? false,
  openByDefault: spec.openByDefault ?? false,
});

describe('the threads client part registers thread-spawn with chat.views/v1', () => {
  test('defines threads-spawn-call and registers thread-spawn drawn by it, standalone', async (t) => {
    const activation = await activateWith({ views: true });
    t.after(activation.cleanup);

    assert.ok(
      activation.defined.includes('threads-spawn-call'),
      `defined: ${activation.defined.join(', ')}`,
    );
    assert.deepEqual(activation.registered.map(facts), [
      {
        toolName: 'thread-spawn',
        elementTag: 'threads-spawn-call',
        standalone: true,
        openByDefault: false,
      },
    ]);
    // The delegated input's renderer stays as it was.
    assert.deepEqual(activation.renderers, ['chat.delegated-input/v1']);
    assert.deepEqual(activation.failures, []);
  });

  test('the cleanup disposes the registration', async () => {
    const activation = await activateWith({ views: true });
    activation.cleanup();

    assert.ok(
      activation.disposed.includes('thread-spawn'),
      `disposed: ${activation.disposed.join(', ')}`,
    );
  });

  test('a refused thread-spawn registration leaves the delegated input renderer in place', async (t) => {
    const activation = await activateWith({ views: true, refuseTool: true });
    t.after(activation.cleanup);

    assert.equal(activation.failures.length, 1);
    assert.deepEqual(activation.renderers, ['chat.delegated-input/v1']);
    assert.deepEqual(activation.disposed, []);
  });

  test('without chat.views/v1 it still defines its element and registers nothing', async (t) => {
    const activation = await activateWith({ views: false });
    t.after(activation.cleanup);

    assert.ok(activation.defined.includes('threads-spawn-call'));
    assert.deepEqual(activation.registered, []);
    assert.deepEqual(activation.failures, []);
  });
});
