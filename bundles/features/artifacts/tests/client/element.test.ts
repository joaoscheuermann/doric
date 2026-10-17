// The frame element as the conversation mounts it: the title, the kind, the
// revision reading, the comment gesture with the count of what is still
// pending, the kind's body mounted inside it (or the orphan state of a kind
// without one) and the authorize gesture under `request`. The frame draws no
// list of revisions: the conversation is the history.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { Services } from 'bundle/contracts';
import { Window } from 'happy-dom';

const window = new Window();
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'customElements',
] as const;

let defineFrameElement: typeof import('../../src/client/elements.js')['defineFrameElement'];
let ArtifactsV1: typeof import('../../src/contracts/index.js')['ArtifactsV1'];
let ArtifactKindV1: typeof import('../../src/contracts/index.js')['ArtifactKindV1'];
let UiV1: typeof import('bundle/contracts')['UiV1'];
let CommentsV1: typeof import('../../src/client/comments-contract.js')['CommentsV1'];

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: window[name as keyof Window],
      writable: true,
    });
  }

  ({ defineFrameElement } = await import('../../src/client/elements.js'));
  ({ ArtifactsV1, ArtifactKindV1 } = await import(
    '../../src/contracts/index.js'
  ));
  ({ UiV1 } = await import('bundle/contracts'));
  ({ CommentsV1 } = await import('../../src/client/comments-contract.js'));
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** A services stub that answers by contract id, as the papercraft tests do. */
const servicesFor = (apiOf: (id: string) => unknown): Services =>
  ({
    provide: () => ({ dispose: () => undefined }),
    use: (contract: unknown) => apiOf((contract as { id?: string }).id ?? ''),
    whenAvailable: () => ({ dispose: () => undefined }),
  }) as unknown as Services;

/**
 * Registers one factory class as a custom element of this window and creates
 * an instance — the custom element pattern happy-dom requires, as the
 * conversation's own registry creates the elements chat draws.
 */
let tag = 0;

const mount = (factory: () => unknown): Record<string, unknown> & Element => {
  const name = `artifacts-element-${tag++}`;

  window.customElements.define(name, factory() as never);

  return window.document.createElement(name) as unknown as Record<
    string,
    unknown
  > &
    Element;
};

const frameBlock = {
  id: 'artifacts.frame:checkout-7f3a@1',
  type: 'artifacts.frame/v1',
  promptId: 'pr1',
  sequence: 3,
  data: {
    artifactId: 'checkout-7f3a',
    revision: 1,
    kind: 'diagram',
    title: 'The flow',
    targets: [{ path: 'docs/Flow.md' }],
    entries: [{ path: 'flow.svg', sha256: '7'.repeat(64) }],
    createdAt: '2024-01-01T00:00:00Z',
    projectId: 'p1',
    threadId: 't1',
  },
};

/** Comments as the registry lists them for one artifact (every revision). */
const commentsApi = (comments: readonly unknown[]) => ({
  list: async (input: { readonly target?: { readonly id?: string } }) =>
    comments.filter(
      (comment) =>
        (comment as { target: { id: string } }).target.id === input.target?.id,
    ),
});

const commentsFor = (comments: unknown[]) =>
  servicesFor((id) =>
    id === CommentsV1.id ? commentsApi(comments) : undefined,
  );

const shadowOf = (node: unknown): ShadowRoot =>
  (node as HTMLElement).shadowRoot as ShadowRoot;

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await tick();
};

test('the frame shows the title, the kind, the revision and the pending comments', async () => {
  const frame = mount(defineFrameElement);
  const comments = [
    { target: { id: 'checkout-7f3a', revision: 1 }, resolved: false },
    { target: { id: 'checkout-7f3a', revision: 1 }, resolved: true },
    { target: { id: 'checkout-7f3a', revision: 2 }, resolved: false },
    { target: { id: 'other', revision: 1 }, resolved: false },
  ];

  frame.services = commentsFor(comments);
  frame.block = frameBlock;
  await settle();

  const bar = shadowOf(frame).querySelector('.artifacts-bar') as HTMLElement;
  const text = (selector: string) =>
    (bar.querySelector(selector) as HTMLElement).textContent;

  assert.equal(text('.artifacts-title'), 'The flow');
  assert.equal(text('.artifacts-kind'), 'diagram');
  assert.equal(text('.artifacts-revision'), 'rev 1');
  // One pending on this revision; the resolved one and revision 2's do not count.
  assert.equal(text('.artifacts-comment'), 'Comentar (1)');
});

test('the frame shows the entries and the orphan state of a kind without a body', async () => {
  const frame = mount(defineFrameElement);

  frame.services = commentsFor([]);
  frame.block = frameBlock;
  await settle();

  const root = shadowOf(frame);
  const orphan = root.querySelector('.artifacts-orphan') as HTMLElement;

  assert.equal(orphan.hidden, false);
  assert.match(orphan.textContent ?? '', /Sem renderizador/);
  assert.deepEqual(
    [...root.querySelectorAll('.artifacts-entry')].map(
      (entry) => entry.textContent,
    ),
    [`flow.svg · ${'7'.repeat(12)}`],
  );
});

/** Services where the `diagram` kind declares a body, and `ui/v1` makes it. */
const bodiedServices = (
  created: { tag: string; props?: Record<string, unknown> }[],
  extra: (id: string) => unknown = () => undefined,
  header?: 'frame' | 'body',
) =>
  servicesFor((id) => {
    if (id === ArtifactKindV1.id) {
      return {
        list: async () => [
          {
            id: 'diagram',
            blockType: 'diagram.body/v1',
            bodyTag: 'diagram-body',
            ...(header === undefined ? {} : { header }),
          },
        ],
      };
    }

    if (id === UiV1.id) {
      return {
        create: (tag: string, props?: Record<string, unknown>) => {
          created.push({ tag, props });

          const node = window.document.createElement('div');
          Object.assign(node, props ?? {});

          return node;
        },
        dispose: () => undefined,
      };
    }

    if (id === CommentsV1.id) return commentsApi([]);

    return extra(id);
  });

test("the frame mounts the kind's body with its block, and no revision list", async () => {
  const frame = mount(defineFrameElement);
  const created: { tag: string; props?: Record<string, unknown> }[] = [];
  // Two revisions, the second with the agent's change note.
  const artifacts = {
    policy: async () => ({ policy: 'proceed' }),
    revisions: async () => [
      { artifactId: 'checkout-7f3a', revision: 1, state: 'open' },
      {
        artifactId: 'checkout-7f3a',
        revision: 2,
        state: 'open',
        changeNote: 'Smaller button',
      },
    ],
  };

  frame.services = bodiedServices(created, (id) =>
    id === ArtifactsV1.id ? artifacts : undefined,
  );
  frame.block = frameBlock;
  await settle();

  const root = shadowOf(frame);
  const body = created.find((entry) => entry.tag === 'diagram-body');

  assert.equal(
    (body?.props?.block as { type?: string } | undefined)?.type,
    'diagram.body/v1',
  );
  assert.deepEqual(
    (body?.props?.block as { data?: unknown } | undefined)?.data,
    frameBlock.data,
  );
  assert.equal(
    (root.querySelector('.artifacts-orphan') as HTMLElement).hidden,
    true,
  );
  // The body is light DOM slotted into the frame, so the window's sheets
  // style it; it is not inside the frame's shadow root.
  const slotted = (frame as unknown as HTMLElement).querySelector(
    '[slot="body"]',
  );
  assert.equal(
    (slotted as { block?: { type?: string } } | null)?.block?.type,
    'diagram.body/v1',
  );
  assert.equal(root.querySelector('[slot="body"]'), null);
  assert.ok(root.querySelector('.artifacts-body slot[name="body"]'));
  // The conversation is the history: the frame lists no revisions, and
  // creates nothing but the kind's body.
  assert.deepEqual(
    created.map((entry) => entry.tag),
    ['diagram-body'],
  );
  assert.doesNotMatch(root.textContent ?? '', /rev \d+\/\d+|Smaller button/);
});

test('the frame offers to authorize an open revision only under request', async () => {
  const approvals: unknown[] = [];
  const state = { policy: 'request' as 'request' | 'proceed' };
  const artifacts = {
    policy: async () => ({ policy: state.policy }),
    revisions: async () => [
      { artifactId: 'checkout-7f3a', revision: 1, state: 'open' },
    ],
    approve: async (input: unknown) => {
      approvals.push(input);
    },
  };
  const frame = mount(defineFrameElement);

  frame.services = bodiedServices([], (id) =>
    id === ArtifactsV1.id ? artifacts : undefined,
  );
  frame.block = frameBlock;
  await settle();

  const authorize = shadowOf(frame).querySelector(
    '.artifacts-authorize',
  ) as HTMLButtonElement;

  assert.equal(authorize.hidden, false);
  authorize.click();
  await settle();
  assert.deepEqual(approvals, [{ artifactId: 'checkout-7f3a', revision: 1 }]);

  state.policy = 'proceed';
  frame.block = { ...frameBlock };
  await settle();
  assert.equal(authorize.hidden, true);
});

test('a body that draws its header leaves no bar, and Autorizar below the body', async () => {
  const artifacts = {
    policy: async () => ({ policy: 'request' }),
    revisions: async () => [
      { artifactId: 'checkout-7f3a', revision: 1, state: 'open' },
    ],
    approve: async () => undefined,
  };
  const frame = mount(defineFrameElement);

  frame.services = bodiedServices(
    [],
    (id) => (id === ArtifactsV1.id ? artifacts : undefined),
    'body',
  );
  frame.block = frameBlock;
  await settle();

  const root = shadowOf(frame);

  // No title, kind, revision or Comentar of the frame's: the body has them.
  assert.equal(
    (root.querySelector('.artifacts-bar') as HTMLElement).hidden,
    true,
  );

  // Autorizar is still the registry's, under the body.
  const authorize = root.querySelector(
    '.artifacts-below .artifacts-authorize',
  ) as HTMLButtonElement | null;
  assert.ok(authorize !== null);
  assert.equal(authorize.hidden, false);
  assert.equal(
    (root.querySelector('.artifacts-below') as HTMLElement).hidden,
    false,
  );
});

test('the kinds are read once for every frame of a window, and blocks set during a render draw once after it', async () => {
  const counts = { kinds: 0, revisions: 0 };
  const services = servicesFor((id) => {
    if (id === ArtifactKindV1.id) {
      return {
        list: async () => {
          counts.kinds += 1;

          return [
            {
              id: 'diagram',
              blockType: 'diagram.body/v1',
              bodyTag: 'diagram-body',
            },
          ];
        },
      };
    }

    if (id === UiV1.id) {
      return {
        create: (_tag: string, props?: Record<string, unknown>) =>
          Object.assign(window.document.createElement('div'), props ?? {}),
        dispose: () => undefined,
      };
    }

    if (id === ArtifactsV1.id) {
      return {
        policy: async () => ({ policy: 'proceed' }),
        revisions: async () => {
          counts.revisions += 1;

          return [{ artifactId: 'checkout-7f3a', revision: 1, state: 'open' }];
        },
      };
    }

    if (id === CommentsV1.id) return commentsApi([]);

    return undefined;
  });

  // One definition per window, as the activation makes it; two frames of it.
  const name = `artifacts-element-${tag++}`;
  window.customElements.define(name, defineFrameElement() as never);
  const frames = [1, 2].map(
    () =>
      window.document.createElement(name) as unknown as Record<
        string,
        unknown
      > &
        Element,
  );

  for (const frame of frames) {
    frame.services = services;
    frame.block = frameBlock;
  }
  await settle();

  assert.equal(counts.kinds, 1);
  assert.equal(counts.revisions, 2);

  // The conversation reads the log again and again while a prompt runs:
  // three readings of the same block, back to back, draw the frame twice —
  // the one under way, then one more for the latest reading.
  const [first] = frames as [Record<string, unknown> & Element];
  first.block = { ...frameBlock };
  first.block = { ...frameBlock };
  first.block = { ...frameBlock };
  await settle();

  assert.equal(counts.kinds, 1);
  assert.equal(counts.revisions, 4);
});

test('the comment gesture goes to a surface that takes it, else to the body', async () => {
  const frame = mount(defineFrameElement);
  const asked: unknown[] = [];

  frame.services = bodiedServices([]);
  frame.block = frameBlock;
  await settle();

  const body = (frame as unknown as HTMLElement).querySelector(
    '[slot="body"]',
  ) as unknown as { comment?: (detail: unknown) => void };

  body.comment = (detail) => asked.push(detail);

  const comment = shadowOf(frame).querySelector(
    '.artifacts-comment',
  ) as HTMLButtonElement;
  const taken: unknown[] = [];
  const take = (event: Event) => {
    taken.push((event as CustomEvent).detail);
    event.preventDefault();
  };

  window.document.body.append(frame as never);
  window.document.addEventListener('artifacts:comment', take as never);
  comment.click();
  window.document.removeEventListener('artifacts:comment', take as never);
  comment.click();

  const detail = { artifactId: 'checkout-7f3a', revision: 1, kind: 'diagram' };

  assert.deepEqual(taken, [detail]);
  assert.deepEqual(asked, [detail]);
});
