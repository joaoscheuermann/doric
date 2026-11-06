// C8 (conversation-openui.md D29): `<openui-fence>`'s component. With
// `createFenceShell` over a fake `ChunkLoader` (the lazily imported renderer
// chunk is the boundary): the source with "Writing…" or "Drawing…" until a
// revision can be drawn, D2's footer, `latest` and `superseded` from the
// Thread's fences, and a failed import. With the real chunk's
// `ConversationFence`: `Modal` drawn inline, a crash and its `render-error`,
// the check's `tool-not-found` for `Query`, D7's hint on `unknown-component`.
// And the entry's `answersProjector`, which draws nothing.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { Services } from 'bundle/contracts';
import { act, type ComponentType, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  ChatFence,
  ChatFenceView,
} from '../../src/client/chat-contract.js';
import type { ConversationFenceProps } from '../../src/client/chunks/renderer.js';
import {
  createFenceShell,
  FENCE_ELEMENT_TAG,
} from '../../src/client/fence-element.js';
import {
  type ChunkLoader,
  createChunkLoader,
  isQuestionLine,
  type RendererChunk,
} from '../../src/client/folds.js';
import {
  createProgramFolds,
  type ProgramErrorsInput,
  type ProgramRevision,
} from '../../src/contracts/index.js';
import { activateClient } from './support/client.js';
import { closeWindow, settle } from './support/dom.js';
import {
  chatFence,
  fenceServices,
  mountFence,
  revisionOf,
} from './support/fence.js';

after(closeWindow);

const FOOTER = 'Incomplete: the answer ended before the fence closed';
const HINT =
  'Repository components and Export exist only in papercraft fences.';

/** The props the fake chunk's `ConversationFence` was last drawn with, by fence key. */
const drawn = new Map<string, ConversationFenceProps>();

/** A renderer chunk at the import boundary: a recording `ConversationFence`, a concatenating merge, and a `questionOf` that rejects programs holding INVALID. */
const fakeChunk = (): RendererChunk =>
  ({
    ConversationFence: (props: ConversationFenceProps) => {
      drawn.set(props.view.fence.key, props);
      return createElement(
        'div',
        { 'data-fake-fence': props.view.fence.key },
        `drawn ${props.revision.identity} r${props.revision.revision}`,
      );
    },
    mergeStatements: (existing: string, patch: string) => `${existing}${patch}`,
    questionOf: (program: string) =>
      program.includes('INVALID')
        ? { issue: 'Invalid input', questions: [] }
        : { input: { questions: [] }, questions: [] },
  }) as unknown as RendererChunk;

/** A loader whose import settles when the test says so. */
const controlledLoader = () => {
  const chunk = fakeChunk();
  let resolve: (value: RendererChunk) => void = () => undefined;
  const promise = new Promise<RendererChunk>((done) => {
    resolve = done;
  });
  let loaded: ReturnType<ChunkLoader['loaded']>;
  let loads = 0;
  const loader: ChunkLoader = {
    load: () => {
      loads += 1;
      return promise;
    },
    loaded: () => loaded,
  };
  return {
    loader,
    loads: () => loads,
    settle: async () => {
      loaded = {
        chunk,
        folds: createProgramFolds(chunk.mergeStatements, isQuestionLine),
      };
      resolve(chunk);
      await settle(10);
    },
  };
};

const services = fenceServices().services;

interface Shown {
  readonly container: HTMLElement;
  readonly root: Root;
  render(view: unknown): Promise<void>;
  unmount(): Promise<void>;
}

const show = async (
  Shell: ComponentType<{ view?: unknown; services: Services }>,
  view: unknown,
): Promise<Shown> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (next: unknown) => {
    await act(async () => {
      root.render(createElement(Shell, { view: next, services }));
    });
  };
  await render(view);
  return {
    container,
    root,
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const viewOf = (
  fence: ChatFence,
  fences: readonly ChatFence[] = [fence],
): ChatFenceView => ({
  fence,
  origin: 'user',
  fences,
});

test('the element tag is openui-fence', () => {
  assert.equal(FENCE_ELEMENT_TAG, 'openui-fence');
});

test('isQuestionLine accepts a root = AskForm( line only', () => {
  assert.equal(isQuestionLine('root = AskForm([q1])'), true);
  assert.equal(isQuestionLine('root=AskForm([q1])'), true);
  assert.equal(isQuestionLine('form = AskForm([q1])'), false);
  assert.equal(isQuestionLine('root = Stack([form])'), false);
});

test('createChunkLoader imports once and gives the chunk and folds once loaded', async () => {
  let imports = 0;
  const chunk = fakeChunk();
  const loader = createChunkLoader(async () => {
    imports += 1;
    return chunk;
  });

  assert.equal(loader.loaded(), undefined);
  const first = loader.load();
  const second = loader.load();
  assert.equal(first, second);
  assert.equal(await first, chunk);
  assert.equal(loader.loaded()?.chunk, chunk);
  assert.ok(loader.loaded()?.folds !== undefined);
  assert.equal(imports, 1);
});

test('before the import settles a fence with a completed line shows its source with "Drawing…"', async () => {
  const { loader, settle: load } = controlledLoader();
  const Shell = createFenceShell(loader);
  const fence = chatFence('root = Stack([t])\nt = TextContent("Hi")\n', {
    state: 'streaming',
  });

  const shown = await show(Shell, viewOf(fence));
  assert.ok(shown.container.textContent?.includes('root = Stack([t])'));
  assert.ok(shown.container.textContent?.includes('Drawing…'));

  await load();
  await shown.render(viewOf(fence));
  assert.ok(shown.container.querySelector('[data-fake-fence]') !== null);
  assert.equal(shown.container.textContent?.includes('Drawing…'), false);
  await shown.unmount();
});

test('a fence with no completed line shows its source with "Writing…", before and after the load; an unterminated one the footer', async () => {
  const { loader, settle: load } = controlledLoader();
  const Shell = createFenceShell(loader);
  const writing = chatFence('root = Stack(', { state: 'streaming' });

  const shown = await show(Shell, viewOf(writing));
  assert.ok(shown.container.textContent?.includes('root = Stack('));
  assert.ok(shown.container.textContent?.includes('Writing…'));

  await load();
  await shown.render(viewOf(writing));
  assert.ok(shown.container.textContent?.includes('Writing…'));
  assert.equal(shown.container.querySelector('[data-fake-fence]'), null);

  const cut = chatFence('root = Stack(', { state: 'unterminated' });
  await shown.render(viewOf(cut));
  assert.ok(shown.container.textContent?.includes(FOOTER));
  assert.equal(shown.container.textContent?.includes('Writing…'), false);
  await shown.unmount();
});

test('latest is false for an earlier revision of an identity and true for its last', async () => {
  const { loader, settle: load } = controlledLoader();
  await load();
  const Shell = createFenceShell(loader);
  const one = chatFence('root = Stack([t])\nt = TextContent("a")\n', {
    info: 'openui-lang plan',
    promptId: 'p1',
  });
  const two = chatFence('t = TextContent("b")\n', {
    info: 'openui-lang plan',
    promptId: 'p2',
  });
  const fences = [one, two];

  const first = await show(Shell, viewOf(one, fences));
  const second = await show(Shell, viewOf(two, fences));

  assert.equal(drawn.get(one.key)?.latest, false);
  assert.equal(drawn.get(two.key)?.latest, true);
  assert.equal(drawn.get(two.key)?.revision.revision, 2);
  await first.unmount();
  await second.unmount();
});

test('a question is superseded by a later closed valid question, not by a streaming, cut-off or invalid one', async () => {
  const { loader, settle: load } = controlledLoader();
  await load();
  const Shell = createFenceShell(loader);
  const asked = chatFence('root = AskForm([q1])\n', { promptId: 'p1' });
  const later = (state: ChatFence['state'], body = 'root = AskForm([q2])\n') =>
    chatFence(body, { promptId: 'p2', state });

  const cases: [ChatFence, boolean][] = [
    [later('closed'), true],
    [later('streaming'), false],
    [later('unterminated'), false],
    [later('closed', 'root = AskForm([INVALID])\n'), false],
  ];

  for (const [next, superseded] of cases) {
    drawn.delete(asked.key);
    const shown = await show(Shell, viewOf(asked, [asked, next]));
    assert.equal(drawn.get(asked.key)?.superseded, superseded, next.state);
    assert.equal(drawn.get(asked.key)?.revision.question, true);
    await shown.unmount();
  }
});

test('a failed chunk import shows the message beside the source, with no second import', async () => {
  let imports = 0;
  const loader = createChunkLoader(async () => {
    imports += 1;
    throw new Error('network down');
  });
  const Shell = createFenceShell(loader);
  const fence = chatFence('root = Stack([t])\nt = TextContent("Hi")\n');

  const one = await show(Shell, viewOf(fence));
  await settle(10);
  await one.render(viewOf(fence));
  const two = await show(Shell, viewOf(fence));
  await settle(10);
  await two.render(viewOf(fence));

  for (const shown of [one, two]) {
    assert.ok(
      shown.container.textContent?.includes(
        'The UI renderer did not load: network down',
      ),
    );
    assert.ok(shown.container.textContent?.includes('root = Stack([t])'));
  }
  assert.equal(imports, 1);
  await one.unmount();
  await two.unmount();
});

test('a view that is not a ChatFenceView draws nothing', async () => {
  const { loader } = controlledLoader();
  const shown = await show(createFenceShell(loader), { nope: true });

  assert.equal(shown.container.innerHTML, '');
  await shown.unmount();
});

// With the real chunk.

const mountProgram = async (
  body: string,
  revision: Partial<ProgramRevision> = {},
) => {
  const fence = chatFence(body, { info: 'openui-lang view' });
  const { services: stub, calls } = fenceServices();
  const mounted = await mountFence({
    view: viewOf(fence),
    revision: revisionOf(fence, { identity: 'view', ...revision }),
    services: stub,
  });
  await settle(20);
  return {
    mounted,
    calls,
    reports: () =>
      calls.reports.map(({ input }) => input as ProgramErrorsInput),
  };
};

test('a Modal with open state true draws inside the element, with nothing added to document.body', async () => {
  const before = document.body.children.length;
  const { mounted } = await mountProgram(
    'root = Stack([m])\n$open = true\nm = Modal("Details", $open, [t])\nt = TextContent("Inside the dialog")\n',
  );

  assert.ok(mounted.container.textContent?.includes('Inside the dialog'));
  assert.equal(document.body.children.length, before + 1);
  await mounted.unmount();
});

test('a render crash shows "This UI failed to draw" and reports render-error once', async () => {
  // A program that is not text makes react-lang's own response parsing throw
  // (`text.replace` on a number) while `Renderer` draws, outside the
  // per-element boundary OpenUI puts around each library component; `null`
  // would not do, as `Renderer` reads it as an empty response.
  const { mounted, reports } = await mountProgram('root = Stack([t])\n', {
    program: 42 as unknown as string,
  });

  assert.ok(mounted.container.textContent?.includes('This UI failed to draw'));
  const renderErrors = reports()
    .flatMap(({ errors }) => errors)
    .filter(({ code }) => code === 'render-error');
  assert.equal(renderErrors.length, 1);
  assert.equal(reports().length, 1);
  await mounted.unmount();
});

test('a fence that calls Query reports one tool-not-found with the hint', async () => {
  const { mounted, reports } = await mountProgram(
    'root = Stack([t])\ndata = Query("list_users", {})\nt = TextContent("Users")\n',
  );

  assert.deepEqual(
    reports()
      .flatMap(({ errors }) => errors)
      .filter(({ code }) => code === 'tool-not-found'),
    [
      {
        code: 'tool-not-found',
        statementId: 'data',
        message:
          'Query and Mutation are not available; write the data as literals.',
      },
    ],
  );
  await mounted.unmount();
});

test("an unknown-component error's message ends with D7's hint", async () => {
  const { mounted, reports } = await mountProgram(
    'root = Stack([c])\nc = Chart3D("x")\n',
  );

  const unknown = reports()
    .flatMap(({ errors }) => errors)
    .filter(({ code }) => code === 'unknown-component');
  assert.ok(unknown.length >= 1);
  for (const error of unknown) {
    assert.ok(error.message?.endsWith(HINT), error.message);
    assert.ok((error.message?.length ?? 0) <= 300);
  }
  await mounted.unmount();
});

test('answersProjector gives no block for an openui.answered/v1 row', async () => {
  const world = await activateClient();
  await settle();

  const projector = world.projectors.find(({ spec }) =>
    spec.eventTypes.includes('openui.answered/v1'),
  );
  assert.ok(projector !== undefined);
  assert.deepEqual(projector.spec.eventTypes, ['openui.answered/v1']);
  const row = {
    projectId: 'project-1',
    threadId: 'thread-1',
    promptId: 'a1',
    sequence: 3,
    type: 'openui.answered/v1',
    event: {
      type: 'openui.answered/v1',
      questionPromptId: 'q1',
      digest: 'a'.repeat(64),
      answers: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(
    projector.spec.reduce(projector.spec.initial(), row).blocks,
    [],
  );
  await world.deactivate();
});
