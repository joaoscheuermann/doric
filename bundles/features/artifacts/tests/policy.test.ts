// The review policy: `proceed` publishes and moves on, `request` gates the
// write back into the Project's code. `policy()` is what a UI reads; `approve`
// records the gesture and stays idempotent where the gesture exists.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { artifactReviewPolicy } from '../src/contracts/index.js';
import { artifactsHarness } from './support/harness.js';

const at = {
  artifactId: 'checkout-7f3a',
  kind: 'preview',
  title: 'Checkout',
  targets: [],
};

describe('artifacts.review-policy/v1', () => {
  test('defaults to proceed and follows the stored choice', async () => {
    const harness = await artifactsHarness();

    try {
      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'proceed',
      });
      assert.deepEqual(harness.settings.registered, [artifactReviewPolicy.id]);

      harness.settings.values.set(artifactReviewPolicy.id, {
        policy: 'request',
      });

      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'request',
      });
    } finally {
      await harness.close();
    }
  });

  test('setPolicy writes the choice the registry reads back', async () => {
    const harness = await artifactsHarness();

    try {
      assert.deepEqual(
        await harness.artifacts.setPolicy(
          { policy: 'request' },
          harness.call(),
        ),
        { policy: 'request' },
      );
      assert.deepEqual(harness.settings.values.get(artifactReviewPolicy.id), {
        policy: 'request',
      });
      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'request',
      });

      assert.deepEqual(
        await harness.artifacts.setPolicy(
          { policy: 'proceed' },
          harness.call(),
        ),
        { policy: 'proceed' },
      );
      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'proceed',
      });
    } finally {
      await harness.close();
    }
  });

  test('setPolicy refuses a value the settings space never accepts', async () => {
    const harness = await artifactsHarness();

    try {
      await assert.rejects(
        async () =>
          harness.artifacts.setPolicy(
            { policy: 'maybe' } as unknown as { policy: 'proceed' | 'request' },
            harness.call(),
          ),
        { code: 'invalid_input' },
      );
      assert.equal(harness.settings.values.has(artifactReviewPolicy.id), false);
    } finally {
      await harness.close();
    }
  });

  test('under request, approving writes the state and the event', async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(at, harness.call());

      const approved = await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );

      assert.equal(approved?.state, 'approved');
      assert.deepEqual(
        harness.events.appended.map((entry) => entry.type),
        ['artifacts.created/v1', 'artifacts.approved/v1'],
      );
      assert.deepEqual(harness.events.appended[1]?.payload, {
        artifactId: at.artifactId,
        revision: 1,
        scope: 'revision',
      });

      const again = await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );

      assert.equal(again?.state, 'approved');
      assert.equal(harness.events.appended.length, 2);

      assert.equal(
        (
          await harness.artifacts.read(
            { artifactId: at.artifactId },
            harness.call(),
          )
        )?.state,
        'approved',
      );
    } finally {
      await harness.close();
    }
  });

  test('under proceed, approving records the event and keeps the artifact open', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(at, harness.call());

      const approved = await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );

      assert.equal(approved?.state, 'open');
      assert.deepEqual(
        harness.events.appended.map((entry) => entry.type),
        ['artifacts.created/v1', 'artifacts.approved/v1'],
      );
    } finally {
      await harness.close();
    }
  });

  test('answers undefined for an artifact or revision that does not exist', async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      assert.equal(
        await harness.artifacts.approve(
          { artifactId: 'missing', revision: 1 },
          harness.call(),
        ),
        undefined,
      );

      await harness.artifacts.create(at, harness.call());

      assert.equal(
        await harness.artifacts.approve(
          { artifactId: at.artifactId, revision: 4 },
          harness.call(),
        ),
        undefined,
      );
      assert.deepEqual(
        harness.events.appended.map((entry) => entry.type),
        ['artifacts.created/v1'],
      );
    } finally {
      await harness.close();
    }
  });
});
