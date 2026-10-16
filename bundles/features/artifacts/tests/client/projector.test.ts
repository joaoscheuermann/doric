// The artifacts projector: `artifacts.created/v1` and `artifacts.revised/v1`
// become one `artifacts.frame/v1` block per revision, with the frame data the
// one reducer holds; `approved` and `applied` fold into the same state and
// draw nothing.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ChatThreadEvent } from '../../src/client/chat-contract.js';
import {
  ARTIFACT_FRAME_BLOCK_TYPE,
  ARTIFACT_REVIEW_EVENT_TYPES,
  createArtifactsProjector,
} from '../../src/client/projector.js';

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

const created = (artifactId: string, kind: string, sequence: number) =>
  event(
    'artifacts.created/v1',
    {
      artifactId,
      revision: 1,
      kind,
      title: 'Checkout',
      targets: [{ path: 'src/checkout.html' }],
      entries: [{ path: 'index.html', sha256: 'a'.repeat(64) }],
    },
    sequence,
  );

const revised = (artifactId: string, revision: number, sequence: number) =>
  event(
    'artifacts.revised/v1',
    {
      artifactId,
      revision,
      changeNote: 'Smaller',
      targets: [{ path: 'src/checkout.html', line: 9 }],
      entries: [{ path: 'index.html', sha256: 'b'.repeat(64) }],
    },
    sequence,
  );

describe('the artifacts projector', () => {
  test('claims every artifacts event, or the review pair alone', () => {
    assert.deepEqual(createArtifactsProjector().eventTypes, [
      'artifacts.created/v1',
      'artifacts.revised/v1',
      'artifacts.approved/v1',
      'artifacts.applied/v1',
    ]);
    assert.deepEqual(
      createArtifactsProjector(ARTIFACT_REVIEW_EVENT_TYPES).eventTypes,
      ['artifacts.approved/v1', 'artifacts.applied/v1'],
    );
  });

  test('draws one frame per revision, naming the kind and title the artifact was created with', () => {
    const projector = createArtifactsProjector();
    const first = projector.reduce(
      projector.initial(),
      created('checkout-7f3a', 'preview', 1),
    );
    const second = projector.reduce(
      first.state,
      revised('checkout-7f3a', 2, 2),
    );

    assert.deepEqual(
      [...first.blocks, ...second.blocks].map((block) => block.id),
      ['artifacts.frame:checkout-7f3a@1', 'artifacts.frame:checkout-7f3a@2'],
    );

    const [block] = second.blocks;

    assert.equal(block?.type, ARTIFACT_FRAME_BLOCK_TYPE);
    assert.equal(block?.sequence, 2);
    assert.deepEqual(block?.data, {
      artifactId: 'checkout-7f3a',
      revision: 2,
      kind: 'preview',
      title: 'Checkout',
      targets: [{ path: 'src/checkout.html', line: 9 }],
      entries: [{ path: 'index.html', sha256: 'b'.repeat(64) }],
      changeNote: 'Smaller',
      createdAt: '2024-01-01T00:00:00Z',
      projectId: 'p1',
      threadId: 't1',
    });
  });

  test('folds approvals and applies without drawing a block for them', () => {
    const projector = createArtifactsProjector();
    const first = projector.reduce(
      projector.initial(),
      created('checkout-7f3a', 'preview', 1),
    );
    const approved = projector.reduce(
      first.state,
      event(
        'artifacts.approved/v1',
        { artifactId: 'checkout-7f3a', revision: 1, scope: 'revision' },
        2,
      ),
    );
    const applied = projector.reduce(
      approved.state,
      event(
        'artifacts.applied/v1',
        { artifactId: 'checkout-7f3a', revision: 1, files: ['a.tsx'] },
        3,
      ),
    );

    assert.equal(approved.blocks.length + applied.blocks.length, 0);

    const artifact = applied.state.artifacts.get('checkout-7f3a');

    assert.equal(artifact?.revisions[0]?.approved, true);
    assert.equal(artifact?.revisions[0]?.applied, true);
  });

  test('draws nothing for a revision the artifact cannot have, or a repeated creation', () => {
    const projector = createArtifactsProjector();
    const first = projector.reduce(
      projector.initial(),
      created('checkout-7f3a', 'preview', 1),
    );

    assert.equal(
      projector.reduce(first.state, revised('checkout-7f3a', 5, 2)).blocks
        .length,
      0,
    );
    assert.equal(
      projector.reduce(first.state, revised('ghost-1', 2, 3)).blocks.length,
      0,
    );
    assert.equal(
      projector.reduce(first.state, created('checkout-7f3a', 'preview', 4))
        .blocks.length,
      0,
    );
    assert.equal(
      projector.reduce(
        projector.initial(),
        event('artifacts.created/v1', null, 5),
      ).blocks.length,
      0,
    );
  });
});
