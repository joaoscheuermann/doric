// The artifacts projector: `artifacts.created/v1` and `artifacts.revised/v1`
// become one `artifacts.frame/v1` block per revision — one per revision, with
// the frame data a frame reads — and nothing else becomes a block.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ChatThreadEvent } from '../../src/client/chat-contract.js';
import {
  ARTIFACT_FRAME_BLOCK_TYPE,
  createArtifactsProjector,
  frameDataOf,
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
  test('claims exactly the created/revised pair', () => {
    const projector = createArtifactsProjector();

    assert.deepEqual(projector.eventTypes, [
      'artifacts.created/v1',
      'artifacts.revised/v1',
    ]);
  });

  test('creates one frame block per revision, in order', () => {
    const projector = createArtifactsProjector();
    const state = projector.initial();

    const first = projector.reduce(
      state,
      created('checkout-7f3a', 'preview', 1),
    );
    const second = projector.reduce(
      first.state,
      revised('checkout-7f3a', 2, 2),
    );

    assert.equal(first.blocks.length, 1);
    assert.equal(second.blocks.length, 1);

    const [block] = second.blocks;

    assert.equal(block?.id, 'artifacts.frame:checkout-7f3a@2');
    assert.equal(block?.type, ARTIFACT_FRAME_BLOCK_TYPE);
    assert.equal(block?.sequence, 2);
    assert.deepEqual(block?.data, {
      artifactId: 'checkout-7f3a',
      revision: 2,
      kind: 'unknown',
      targets: [{ path: 'src/checkout.html', line: 9 }],
      entries: [{ path: 'index.html', sha256: 'b'.repeat(64) }],
      changeNote: 'Smaller',
      createdAt: '2024-01-01T00:00:00Z',
    });
  });

  test('keeps the projection in its state, and comments out of its blocks', () => {
    const projector = createArtifactsProjector();
    const state = projector.initial();

    const folded = projector.reduce(
      state,
      event(
        'comments.added/v1',
        {
          commentId: 'c1',
          target: {
            kind: 'artifact',
            id: 'checkout-7f3a',
            revision: 1,
            anchor: {},
          },
          text: 'aumenta o respiro',
        },
        2,
      ),
    );

    // Comments fold into the state — and never into a block of this projector.
    assert.equal(folded.blocks.length, 0);
  });

  test('draws nothing for a malformed or unsupportable event', () => {
    const projector = createArtifactsProjector();
    const state = projector.initial();

    const drawn = projector.reduce(
      state,
      event('artifacts.revised/v1', { artifactId: 'x' }, 1),
    );

    assert.equal(drawn.blocks.length, 0);
    assert.equal(
      frameDataOf(event('artifacts.created/v1', null, 2)),
      undefined,
    );
  });
});
