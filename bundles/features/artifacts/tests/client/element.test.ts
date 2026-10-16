// The frame element as the conversation mounts it: the title, the kind, the
// revision reading, the comment gesture with the count of what is still
// pending, and the orphan state of a kind without a renderer of its own. And
// the revision list element: one row per revision, read through `artifacts/v1`.

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
let defineRevisionsElement: typeof import('../../src/client/elements.js')['defineRevisionsElement'];
let ArtifactsV1: typeof import('../../src/contracts/index.js')['ArtifactsV1'];
let CommentsV1: typeof import('../../src/client/comments-contract.js')['CommentsV1'];

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: window[name as keyof Window],
      writable: true,
    });
  }

  ({ defineFrameElement, defineRevisionsElement } = await import(
    '../../src/client/elements.js'
  ));
  ({ ArtifactsV1 } = await import('../../src/contracts/index.js'));
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
  },
};

const commentsFor = (comments: unknown[]) =>
  servicesFor((id) =>
    id === CommentsV1.id
      ? {
          list: async (input: {
            readonly target?: {
              readonly id?: string;
              readonly revision?: number;
            };
          }) =>
            comments.filter(
              (comment) =>
                input.target === undefined ||
                ((comment as { target: { id: string } }).target.id ===
                  input.target.id &&
                  (comment as { target: { revision?: number } }).target
                    .revision === input.target.revision),
            ),
        }
      : undefined,
  );

test('the frame shows the title, the kind, the revision and the pending comments', async () => {
  const frame = mount(defineFrameElement);
  const comments = [
    { target: { id: 'checkout-7f3a', revision: 1 }, resolved: false },
    { target: { id: 'checkout-7f3a', revision: 1 }, resolved: true },
    { target: { id: 'other', revision: 1 }, resolved: false },
  ];

  frame.services = commentsFor(comments);
  frame.block = frameBlock;
  await tick();
  await tick();

  const root = (frame as unknown as HTMLElement).shadowRoot as ShadowRoot;
  const bar = root.querySelector('.artifacts-bar') as HTMLElement;

  assert.equal(
    (bar.querySelector('.artifacts-title') as HTMLElement).textContent,
    'The flow',
  );
  assert.equal(
    (bar.querySelector('.artifacts-kind') as HTMLElement).textContent,
    'diagram',
  );
  assert.equal(
    (bar.querySelector('.artifacts-revision') as HTMLElement).textContent,
    'rev 1',
  );
  // Two comments on this revision, one already resolved: one is pending.
  assert.equal(
    (bar.querySelector('.artifacts-comment') as HTMLElement).textContent,
    'Comentar (1)',
  );

  // The entries the revision named, and no invented body.
  const entries = [...root.querySelectorAll('.artifacts-entry')];

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.textContent, `flow.svg · ${'7'.repeat(12)}`);
});

test('the frame shows the orphan state of a kind without a renderer', async () => {
  const frame = mount(defineFrameElement);

  frame.services = commentsFor([]);
  frame.block = {
    ...frameBlock,
    data: { ...frameBlock.data, kind: 'unknown', entries: [] },
  };
  await tick();
  await tick();

  const orphan = (
    (frame as unknown as HTMLElement).shadowRoot as ShadowRoot
  ).querySelector('.artifacts-orphan') as HTMLElement;

  assert.equal(orphan.hidden, false);
  assert.match(orphan.textContent ?? '', /Sem renderizador/);
});

test('the revision list reads one row per revision through artifacts/v1', async () => {
  const list = mount(defineRevisionsElement);
  const records = new Map([
    [
      'checkout-7f3a',
      {
        artifactId: 'checkout-7f3a',
        revision: 2,
        revisions: 2,
        state: 'approved',
        changeNote: 'Smaller',
      },
    ],
    [
      'checkout-7f3a@1',
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        revisions: 2,
        state: 'approved',
      },
    ],
    [
      'checkout-7f3a@2',
      {
        artifactId: 'checkout-7f3a',
        revision: 2,
        revisions: 2,
        state: 'approved',
        changeNote: 'Smaller',
      },
    ],
  ]);

  const services = servicesFor((id) => {
    if (id === ArtifactsV1.id) {
      return {
        read: async (input: {
          readonly artifactId: string;
          readonly revision?: number;
        }) =>
          input.revision === undefined
            ? records.get(input.artifactId)
            : records.get(`${input.artifactId}@${input.revision}`),
      };
    }

    if (id === CommentsV1.id) {
      return {
        list: async () => [
          {
            target: { id: 'checkout-7f3a', revision: 1 },
            resolved: false,
          },
        ],
      };
    }

    return undefined;
  });

  list.services = services;
  list.artifactId = 'checkout-7f3a';
  await tick();
  await tick();
  await tick();
  await tick();

  const rows = [
    ...(
      (list as unknown as HTMLElement).shadowRoot as ShadowRoot
    ).querySelectorAll('.artifacts-revision-row'),
  ];

  assert.equal(rows.length, 2);
  assert.match(rows[0]?.textContent ?? '', /1\/2/);
  assert.match(rows[0]?.textContent ?? '', /comentário pendente/);
  assert.match(rows[1]?.textContent ?? '', /Smaller/);
  assert.match(rows[1]?.textContent ?? '', /autorizado/);
});

test('the revision list says when the artifact is not there anymore', async () => {
  const list = mount(defineRevisionsElement);
  const services = servicesFor((id) =>
    id === ArtifactsV1.id
      ? { read: async () => undefined }
      : id === CommentsV1.id
        ? { list: async () => [] }
        : undefined,
  );

  list.services = services;
  list.artifactId = 'ghost';
  await tick();
  await tick();

  const missing = (
    (list as unknown as HTMLElement).shadowRoot as ShadowRoot
  ).querySelector('.artifacts-missing') as HTMLElement;

  assert.match(missing?.textContent ?? '', /não está mais disponível/);
});
