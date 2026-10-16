// The pure reducer of `artifacts.*` and `comments.added/v1` events
// (`domain/preview-state.ts`): one PreviewState per preview artifact, one
// revision per `created`/`revised`, approvals marked, kinds that are not
// `preview` never claimed, and the registry record resolved to the same shape
// the window reads first.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPreviewEvent,
  commentsOfEvents,
  initialPreviewStates,
  type PreviewLogEvent,
  previewStateOfRecord,
} from '../../src/client/domain/preview-state.js';
import type { ArtifactRecord } from '../../src/contracts/index.js';

const event = (type: string, payload: unknown): PreviewLogEvent => ({
  type,
  event: payload,
});

test('a created preview enters the state with its revision', () => {
  const { states, change } = applyPreviewEvent(
    initialPreviewStates(),
    event('artifacts.created/v1', {
      artifactId: 'checkout-7f3a',
      revision: 1,
      kind: 'preview',
      title: 'Checkout',
    }),
  );

  assert.deepEqual(change, { artifactId: 'checkout-7f3a', revision: 1 });

  const state = states.get('checkout-7f3a');
  assert.equal(state?.title, 'Checkout');
  assert.equal(state?.latest, 1);
  assert.deepEqual(state?.revisions, [
    { revision: 1, title: 'Checkout', approved: false },
  ]);
});

test('a revised preview adds the new revision; the old one stays', () => {
  let states = initialPreviewStates();

  ({ states } = applyPreviewEvent(
    states,
    event('artifacts.created/v1', {
      artifactId: 'checkout-7f3a',
      revision: 1,
      kind: 'preview',
      title: 'Checkout',
    }),
  ));
  ({ states } = applyPreviewEvent(
    states,
    event('artifacts.revised/v1', {
      artifactId: 'checkout-7f3a',
      revision: 2,
      changeNote: 'mais respiro',
    }),
  ));

  const state = states.get('checkout-7f3a');
  assert.deepEqual(
    state?.revisions.map((revision) => revision.revision),
    [1, 2],
  );
  assert.equal(state?.latest, 2);
});

test('kinds that are not preview are never claimed', () => {
  let states = initialPreviewStates();

  // A created of another kind: no state, no change.
  let applied = applyPreviewEvent(
    states,
    event('artifacts.created/v1', {
      artifactId: 'diagram-1',
      revision: 1,
      kind: 'diagram',
    }),
  );
  assert.equal(applied.change, undefined);
  assert.equal(applied.states.size, 0);

  // A revised of an artifact this reducer never saw: nothing either.
  states = applied.states;
  applied = applyPreviewEvent(
    states,
    event('artifacts.revised/v1', { artifactId: 'diagram-1', revision: 2 }),
  );
  assert.equal(applied.change, undefined);
  assert.equal(applied.states.size, 0);
});

test('an approval marks its revision, without a block-worthy change', () => {
  let states = initialPreviewStates();

  ({ states } = applyPreviewEvent(
    states,
    event('artifacts.created/v1', {
      artifactId: 'checkout-7f3a',
      revision: 2,
      kind: 'preview',
    }),
  ));

  const applied = applyPreviewEvent(
    states,
    event('artifacts.approved/v1', {
      artifactId: 'checkout-7f3a',
      revision: 2,
      scope: 'everything',
    }),
  );

  assert.equal(applied.change, undefined);
  assert.equal(
    applied.states
      .get('checkout-7f3a')
      ?.revisions.find((revision) => revision.revision === 2)?.approved,
    true,
  );
});

test('the registry record resolves to the same shape', () => {
  const record: ArtifactRecord = {
    artifactId: 'checkout-7f3a',
    kind: 'preview',
    title: 'Checkout',
    revision: 2,
    revisions: 2,
    targets: [{ path: 'src/checkout.html' }],
    source: 'html',
    path: 'src/checkout.html',
    state: 'approved',
    createdAt: '2024-01-01T00:00:00Z',
  };

  const state = previewStateOfRecord(record);

  assert.equal(state?.latest, 2);
  assert.deepEqual(
    state?.revisions.map((revision) => revision.revision),
    [1, 2],
  );
  assert.equal(
    state?.revisions.find((revision) => revision.revision === 2)?.approved,
    true,
  );
  assert.equal(
    state?.revisions.find((revision) => revision.revision === 1)?.approved,
    false,
  );

  // Not this bundle's kind: undefined, never a preview state.
  assert.equal(previewStateOfRecord({ ...record, kind: 'diagram' }), undefined);
});

test('the durable comments of a revision read off the events, in order', () => {
  const events: readonly PreviewLogEvent[] = [
    event('artifacts.created/v1', {
      artifactId: 'checkout-7f3a',
      revision: 1,
      kind: 'preview',
    }),
    event('comments.added/v1', {
      commentId: 'c1',
      text: 'o botão sumiu no escuro',
      author: 'jao',
      target: {
        kind: 'artifact',
        id: 'checkout-7f3a',
        revision: 1,
        anchor: { form: 'source', path: 'src/Checkout.tsx', line: 42 },
      },
    }),
    event('comments.added/v1', {
      commentId: 'c2',
      text: 'outro alvo',
      target: { kind: 'artifact', id: 'outro', revision: 1, anchor: {} },
    }),
    event('comments.added/v1', {
      commentId: 'c3',
      text: 'da revisão dois',
      target: {
        kind: 'artifact',
        id: 'checkout-7f3a',
        revision: 2,
        anchor: { form: 'point', x: 10, y: 10 },
      },
    }),
  ];

  const ofRevisionOne = commentsOfEvents(events, 'checkout-7f3a', 1);

  assert.equal(ofRevisionOne.length, 1);
  assert.equal(ofRevisionOne[0]?.commentId, 'c1');
  assert.equal(ofRevisionOne[0]?.author, 'jao');
  assert.deepEqual(ofRevisionOne[0]?.anchor, {
    form: 'source',
    path: 'src/Checkout.tsx',
    line: 42,
  });

  const ofAny = commentsOfEvents(events, 'checkout-7f3a');
  assert.equal(ofAny.length, 2);
});
