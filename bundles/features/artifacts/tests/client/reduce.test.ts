// The one reducer: `artifacts.*` and the artifact-anchored `comments.*` fold
// into one state per artifact — the revisions in log order, the current one,
// the review state, and the comments still pending — and the same fold serves
// the node, the window and the revision list.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ChatThreadEvent } from '../../src/client/chat-contract.js';
import {
  initialArtifactsState,
  projectionOf,
  reduceArtifactEvent,
  reduceArtifacts,
} from '../../src/client/reduce.js';

const event = (
  type: string,
  payload: unknown,
  sequence: number,
  createdAt = '2024-01-01T00:00:00Z',
): ChatThreadEvent => ({
  projectId: 'p1',
  threadId: 't1',
  promptId: 'pr1',
  sequence,
  type,
  event: payload,
  createdAt,
});

const created = (artifactId: string, sequence: number, extra = {}) =>
  event(
    'artifacts.created/v1',
    {
      artifactId,
      revision: 1,
      kind: 'preview',
      title: 'Checkout',
      targets: [{ path: 'src/checkout.html' }],
      entries: [{ path: 'index.html', sha256: 'a'.repeat(64) }],
      ...extra,
    },
    sequence,
  );

const revised = (artifactId: string, revision: number, sequence: number) =>
  event(
    'artifacts.revised/v1',
    {
      artifactId,
      revision,
      changeNote: 'Smaller button',
      targets: [{ path: 'src/checkout.html', line: 9 }],
      entries: [{ path: 'index.html', sha256: 'b'.repeat(64) }],
    },
    sequence,
  );

const comment = (
  commentId: string,
  artifactId: string,
  revision: number | undefined,
  sequence: number,
) =>
  event(
    'comments.added/v1',
    {
      commentId,
      target: {
        kind: 'artifact',
        id: artifactId,
        ...(revision === undefined ? {} : { revision }),
        anchor: { form: 'source', path: 'src/checkout.html', line: 1 },
      },
      text: 'aumenta o respiro',
    },
    sequence,
  );

const resolved = (commentId: string, resolved: boolean, sequence: number) =>
  event('comments.resolved/v1', { commentId, resolved }, sequence);

describe('the artifacts reducer', () => {
  test('folds one artifact with one revision from created', () => {
    const state = reduceArtifacts([created('checkout-7f3a', 1)]);

    assert.equal(state.artifacts.size, 1);

    const artifact = state.artifacts.get('checkout-7f3a');

    assert.deepEqual(artifact && projectionOf(artifact), {
      artifactId: 'checkout-7f3a',
      kind: 'preview',
      title: 'Checkout',
      revision: 1,
      revisions: 1,
      state: 'open',
      pendingComments: 0,
    });
    assert.deepEqual(artifact?.revisions[0]?.targets, [
      { path: 'src/checkout.html' },
    ]);
    assert.deepEqual(artifact?.revisions[0]?.entries, [
      { path: 'index.html', sha256: 'a'.repeat(64) },
    ]);
    assert.equal(artifact?.revisions[0]?.approved, false);
    assert.equal(artifact?.revisions[0]?.applied, false);
  });

  test('appends revisions in order, and refuses one the artifact cannot have', () => {
    const state = reduceArtifacts([
      created('checkout-7f3a', 1),
      revised('checkout-7f3a', 2, 2),
      event(
        'artifacts.revised/v1',
        { artifactId: 'checkout-7f3a', revision: 4, targets: [], entries: [] },
        3,
      ),
    ]);

    const artifact = state.artifacts.get('checkout-7f3a');

    assert.equal(artifact?.revisions.length, 2);
    assert.equal(artifact?.revision, 2);
    assert.equal(artifact?.revisions[1]?.changeNote, 'Smaller button');
    assert.deepEqual(artifact?.revisions[1]?.entries, [
      { path: 'index.html', sha256: 'b'.repeat(64) },
    ]);
    // Revision 1 keeps what it was created with — a revision is immutable.
    assert.deepEqual(artifact?.revisions[0]?.entries, [
      { path: 'index.html', sha256: 'a'.repeat(64) },
    ]);
  });

  test('folds approved and applied per revision', () => {
    const state = reduceArtifacts([
      created('checkout-7f3a', 1),
      event(
        'artifacts.approved/v1',
        { artifactId: 'checkout-7f3a', revision: 1, scope: 'revision' },
        2,
      ),
      event(
        'artifacts.applied/v1',
        {
          artifactId: 'checkout-7f3a',
          revision: 1,
          files: ['src/checkout.html'],
        },
        3,
      ),
      event(
        'artifacts.approved/v1',
        { artifactId: 'checkout-7f3a', revision: 1, scope: 'revision' },
        4,
      ),
    ]);

    const artifact = state.artifacts.get('checkout-7f3a');

    assert.equal(artifact?.state, 'approved');
    assert.equal(artifact?.approvedRevision, 1);
    assert.equal(artifact?.revisions[0]?.approved, true);
    assert.equal(artifact?.revisions[0]?.applied, true);
  });

  test('counts the comments still pending per revision and per artifact', () => {
    const state = reduceArtifacts([
      created('checkout-7f3a', 1),
      revised('checkout-7f3a', 2, 2),
      comment('c1', 'checkout-7f3a', 1, 3),
      comment('c2', 'checkout-7f3a', 2, 4),
      resolved('c1', true, 5),
      resolved('c1', true, 6),
    ]);

    const artifact = state.artifacts.get('checkout-7f3a');

    assert.equal(artifact?.pendingComments, 1);
    assert.equal(artifact?.revisions[0]?.pendingComments, 0);
    assert.equal(artifact?.revisions[1]?.pendingComments, 1);
  });

  test('counts a reopened comment again, and ignores what it cannot anchor', () => {
    const state = reduceArtifacts([
      created('checkout-7f3a', 1),
      comment('c1', 'checkout-7f3a', 1, 2),
      resolved('c1', true, 3),
      resolved('c1', false, 4),
      // No revision anchors nowhere; another kind is another registry's.
      comment('c2', 'checkout-7f3a', undefined, 5),
      comment('c3', 'other-artifact', 1, 6),
      comment('c4', 'checkout-7f3a', 9, 7),
      event(
        'comments.added/v1',
        {
          commentId: 'c5',
          target: {
            kind: 'message',
            id: 'm1',
            anchor: { form: 'range', text: 'x' },
          },
          text: 'not an artifact',
        },
        8,
      ),
    ]);

    const artifact = state.artifacts.get('checkout-7f3a');

    assert.equal(artifact?.pendingComments, 1);
    assert.equal(artifact?.revisions[0]?.pendingComments, 1);
    assert.equal(state.comments.has('c2'), false);
    assert.equal(state.comments.has('c3'), false);
    assert.equal(state.comments.has('c4'), false);
    assert.equal(state.comments.has('c5'), false);
  });

  test('ignores malformed and unknown events, and folds incrementally', () => {
    const state0 = initialArtifactsState();
    const state1 = reduceArtifactEvent(state0, created('checkout-7f3a', 1));

    assert.notEqual(state1, state0);
    assert.equal(
      reduceArtifactEvent(state1, created('checkout-7f3a', 1)),
      state1,
    );

    const same = reduceArtifacts([
      event('artifacts.created/v1', { artifactId: 'x' }, 2),
      event('unknown.event/v1', { anything: true }, 3),
      event('comments.resolved/v1', { commentId: 'ghost', resolved: true }, 4),
    ]);

    assert.equal(same.artifacts.size, 0);
  });
});
