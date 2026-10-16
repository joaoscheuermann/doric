// The chat projector of `artifacts.created/v1` / `artifacts.revised/v1`:
// one `papercraft.preview/v1` block per preview revision, and nothing for
// another kind.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatThreadEvent } from '../src/client/chat-contract.js';
import { createPreviewProjector } from '../src/client/projector.js';
import { PREVIEW_BLOCK_TYPE } from '../src/contracts/index.js';

const event = (
  type: string,
  payload: unknown,
  sequence: number,
): ChatThreadEvent => ({
  projectId: 'p1',
  threadId: 't1',
  promptId: 'pr1',
  sequence,
  type,
  event: payload,
  createdAt: '2024-01-01T00:00:00Z',
});

test('a preview created event becomes a preview block', () => {
  const projector = createPreviewProjector();
  const { blocks } = projector.reduce(
    projector.initial(),
    event(
      'artifacts.created/v1',
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        kind: 'preview',
        title: 'Checkout',
      },
      1,
    ),
  );

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, PREVIEW_BLOCK_TYPE);
  assert.equal(blocks[0]?.sequence, 1);
  assert.deepEqual(blocks[0]?.data, {
    artifactId: 'checkout-7f3a',
    revision: 1,
    kind: 'preview',
    title: 'Checkout',
  });
});

test('a revision of a preview produces a second block', () => {
  const projector = createPreviewProjector();
  const created = projector.reduce(
    projector.initial(),
    event(
      'artifacts.created/v1',
      { artifactId: 'checkout-7f3a', revision: 1, kind: 'preview' },
      1,
    ),
  );

  const revised = projector.reduce(
    created.state,
    event(
      'artifacts.revised/v1',
      { artifactId: 'checkout-7f3a', revision: 2 },
      2,
    ),
  );

  assert.equal(revised.blocks.length, 1);
  const block = revised.blocks[0];
  assert.ok(block !== undefined);
  assert.equal(block.type, PREVIEW_BLOCK_TYPE);
  assert.equal((block.data as { revision: number }).revision, 2);
});

test('a created event carries the anchors and entries the revision named', () => {
  const projector = createPreviewProjector();
  const { blocks } = projector.reduce(
    projector.initial(),
    event(
      'artifacts.created/v1',
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        kind: 'preview',
        title: 'Checkout',
        targets: [{ path: 'src/checkout.html', line: 12 }],
        entries: [
          {
            path: 'index.html',
            sha256:
              '0f0f8fe0f048972bdaf68b209e919576620b1a70ee856f6f9751d70f4383000',
          },
        ],
      },
      3,
    ),
  );

  const data = blocks[0]?.data;

  assert.deepEqual(data, {
    artifactId: 'checkout-7f3a',
    revision: 1,
    kind: 'preview',
    title: 'Checkout',
    targets: [{ path: 'src/checkout.html', line: 12 }],
    entries: [
      {
        path: 'index.html',
        sha256:
          '0f0f8fe0f048972bdaf68b209e919576620b1a70ee856f6f9751d70f4383000',
      },
    ],
  });
});

test('a revised event carries its own anchors and entries', () => {
  const projector = createPreviewProjector();
  const created = projector.reduce(
    projector.initial(),
    event(
      'artifacts.created/v1',
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        kind: 'preview',
        title: 'Checkout',
      },
      3,
    ),
  );
  const { blocks } = projector.reduce(
    created.state,
    event(
      'artifacts.revised/v1',
      {
        artifactId: 'checkout-7f3a',
        revision: 2,
        targets: [{ path: 'src/checkout.html' }],
        entries: [{ path: 'index.html', sha256: 'ff'.repeat(32) }],
      },
      4,
    ),
  );

  const data = blocks[0]?.data as { targets?: unknown[]; entries?: unknown[] };

  assert.deepEqual(data.targets, [{ path: 'src/checkout.html' }]);
  assert.deepEqual(data.entries, [
    { path: 'index.html', sha256: 'ff'.repeat(32) },
  ]);
});

test('a block whose event named nothing carries no anchors or entries', () => {
  const projector = createPreviewProjector();
  const { blocks } = projector.reduce(
    projector.initial(),
    event(
      'artifacts.created/v1',
      { artifactId: 'checkout-7f3a', revision: 1, kind: 'preview' },
      1,
    ),
  );

  const data = blocks[0]?.data as Record<string, unknown>;

  assert.equal('targets' in data, false);
  assert.equal('entries' in data, false);
});

test('an entry without a path or a hash is dropped, not half-carried', () => {
  const projector = createPreviewProjector();
  const { blocks } = projector.reduce(
    projector.initial(),
    event(
      'artifacts.created/v1',
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        kind: 'preview',
        entries: [
          { path: 'index.html' },
          { path: 'a.html', sha256: 'ab'.repeat(32) },
        ],
      },
      2,
    ),
  );

  const data = blocks[0]?.data as Record<string, unknown>;

  assert.equal('entries' in data, false);
});

test('another artifact kind produces no preview block', () => {
  const projector = createPreviewProjector();
  const created = projector.reduce(
    projector.initial(),
    event(
      'artifacts.created/v1',
      { artifactId: 'diagram-1', revision: 1, kind: 'diagram' },
      1,
    ),
  );

  assert.equal(created.blocks.length, 0);

  const revised = projector.reduce(
    created.state,
    event('artifacts.revised/v1', { artifactId: 'diagram-1', revision: 2 }, 2),
  );

  assert.equal(revised.blocks.length, 0);
});
