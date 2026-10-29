// The review policy: `proceed` publishes and moves on, with no approval at
// all; `request` gates the write back into the Project's code — per revision,
// per Project. `policy()` is what a UI reads; `approve` records the gesture
// once per revision; `awaitApproval` is what a kind's tool waits on; `apply`
// refuses, under `request`, a revision nobody approved.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  artifactReviewPolicy,
  reviewPolicyOf,
} from '../src/contracts/index.js';
import { artifactsHarness } from './support/harness.js';

const at = {
  artifactId: 'checkout-7f3a',
  kind: 'preview',
  title: 'Checkout',
  targets: [],
};

const types = (harness: { events: { appended: { type: string }[] } }) =>
  harness.events.appended.map((entry) => entry.type);

/** A window's call: scoped to the Project, with no Thread or prompt. */
const windowScope = { projectId: 'project-1' };

describe('artifacts.review-policy/v1', () => {
  test('defaults to proceed and follows the stored choice', async () => {
    const harness = await artifactsHarness();

    try {
      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'proceed',
        exemptKinds: ['diagram'],
      });
      assert.deepEqual(harness.settings.registered, [artifactReviewPolicy.id]);

      harness.settings.values.set(artifactReviewPolicy.id, {
        policy: 'request',
      });

      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'request',
        exemptKinds: ['diagram'],
      });
    } finally {
      await harness.close();
    }
  });

  test('setPolicy chooses for the calling Project only', async () => {
    const harness = await artifactsHarness();
    const other = { projectId: 'project-2' };

    try {
      assert.deepEqual(
        await harness.artifacts.setPolicy(
          { policy: 'request' },
          harness.call(),
        ),
        { policy: 'request' },
      );

      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'request',
        exemptKinds: ['diagram'],
      });
      assert.deepEqual(await harness.artifacts.policy(harness.call(other)), {
        policy: 'proceed',
        exemptKinds: ['diagram'],
      });

      await harness.artifacts.setPolicy({ policy: 'proceed' }, harness.call());

      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'proceed',
        exemptKinds: ['diagram'],
      });
    } finally {
      await harness.close();
    }
  });

  test('setPolicy without a Project sets the default every Project without a choice runs', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.setPolicy({ policy: 'request' }, harness.call());
      await harness.artifacts.setPolicy(
        { policy: 'request' },
        harness.call({}),
      );
      await harness.artifacts.setPolicy(
        { policy: 'proceed' },
        harness.call({ projectId: 'project-1' }),
      );

      // project-1 keeps its own choice; project-2 follows the new default.
      assert.equal(
        (await harness.artifacts.policy(harness.call())).policy,
        'proceed',
      );
      assert.equal(
        (
          await harness.artifacts.policy(
            harness.call({ projectId: 'project-2' }),
          )
        ).policy,
        'request',
      );
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
});

describe('artifacts/v1.approve', () => {
  test('under request, approves the revision once and records one event', async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(at, harness.call());

      const approved = await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );
      const again = await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );

      assert.equal(approved?.state, 'approved');
      assert.equal(again?.state, 'approved');
      assert.deepEqual(types(harness), [
        'artifacts.created/v1',
        'artifacts.approved/v1',
      ]);
      assert.deepEqual(harness.events.appended[1]?.payload, {
        artifactId: at.artifactId,
        revision: 1,
        scope: 'revision',
      });
    } finally {
      await harness.close();
    }
  });

  test('records one event when the same revision is approved twice at once', async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(at, harness.call());

      await Promise.all([
        harness.artifacts.approve(
          { artifactId: at.artifactId, revision: 1 },
          harness.call(),
        ),
        harness.artifacts.approve(
          { artifactId: at.artifactId, revision: 1 },
          harness.call(),
        ),
      ]);

      assert.deepEqual(types(harness), [
        'artifacts.created/v1',
        'artifacts.approved/v1',
      ]);
    } finally {
      await harness.close();
    }
  });

  test('a new revision starts open, and the approved one stays approved', async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(at, harness.call());
      await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );

      const revised = await harness.artifacts.revise(
        { artifactId: at.artifactId, changeNote: 'Smaller' },
        harness.call(),
      );

      assert.equal(revised.state, 'open');
      assert.equal(
        (
          await harness.artifacts.read(
            { artifactId: at.artifactId },
            harness.call(),
          )
        )?.state,
        'open',
      );
      assert.equal(
        (
          await harness.artifacts.read(
            { artifactId: at.artifactId, revision: 1 },
            harness.call(),
          )
        )?.state,
        'approved',
      );
    } finally {
      await harness.close();
    }
  });

  test('under proceed, records nothing and keeps the revision open', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(at, harness.call());

      const approved = await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );

      assert.equal(approved?.state, 'open');
      assert.deepEqual(types(harness), ['artifacts.created/v1']);
    } finally {
      await harness.close();
    }
  });

  test("a window's approval lands in the log of the Thread that created the artifact", async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(at, harness.call());

      const approved = await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(windowScope),
      );

      assert.equal(approved?.state, 'approved');
      assert.equal(
        harness.events.appended[1]?.call.scope?.threadId,
        'thread-1',
      );
      assert.equal(
        harness.events.appended[1]?.call.scope?.promptId,
        'prompt-1',
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
      assert.deepEqual(types(harness), ['artifacts.created/v1']);
    } finally {
      await harness.close();
    }
  });
});

describe('artifacts/v1.awaitApproval and apply under request', () => {
  test('resolves when the revision is approved', async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(at, harness.call());

      const waiting = harness.artifacts.awaitApproval(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );

      await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(windowScope),
      );

      assert.equal((await waiting)?.state, 'approved');
    } finally {
      await harness.close();
    }
  });

  test('resolves at once under proceed, and with the revision open on timeout', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(at, harness.call());

      assert.equal(
        (
          await harness.artifacts.awaitApproval(
            { artifactId: at.artifactId, revision: 1 },
            harness.call(),
          )
        )?.revision,
        1,
      );

      await harness.artifacts.setPolicy({ policy: 'request' }, harness.call());

      assert.equal(
        (
          await harness.artifacts.awaitApproval(
            { artifactId: at.artifactId, revision: 1, timeoutMs: 5 },
            harness.call(),
          )
        )?.state,
        'open',
      );
      assert.equal(
        await harness.artifacts.awaitApproval(
          { artifactId: at.artifactId, revision: 3, timeoutMs: 5 },
          harness.call(),
        ),
        undefined,
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses to apply a revision nobody approved, then applies once approved', async () => {
    const harness = await artifactsHarness({ policy: 'request' });
    const apply = {
      artifactId: at.artifactId,
      revision: 1,
      files: ['src/checkout.tsx'],
    };

    try {
      await harness.artifacts.create(at, harness.call());

      await assert.rejects(harness.artifacts.apply(apply, harness.call()), {
        code: 'invalid_input',
      });
      assert.deepEqual(types(harness), ['artifacts.created/v1']);

      await harness.artifacts.approve(
        { artifactId: at.artifactId, revision: 1 },
        harness.call(),
      );
      await harness.artifacts.apply(apply, harness.call());

      assert.deepEqual(types(harness), [
        'artifacts.created/v1',
        'artifacts.approved/v1',
        'artifacts.applied/v1',
      ]);
    } finally {
      await harness.close();
    }
  });
});

// D21: a kind in `exemptKinds` (default `['diagram']`) runs under `proceed` in
// every Project — no approval to record, nothing to wait for, nothing to
// refuse. Removing the kind from the list gates it again.
describe('artifacts.review-policy/v1 exemptKinds', () => {
  const diagram = { ...at, artifactId: 'flow-1', kind: 'diagram' };

  test('reviewPolicyOf answers proceed for an exempt kind, and the Project choice otherwise', () => {
    const settings = {
      policy: 'proceed' as const,
      projects: { p: 'request' as const },
      exemptKinds: ['diagram'],
    };

    assert.equal(reviewPolicyOf(settings, 'p', 'diagram'), 'proceed');
    assert.equal(reviewPolicyOf(settings, 'p', 'preview'), 'request');
    assert.equal(reviewPolicyOf(settings, 'p'), 'request');
  });

  test('under request, approving a diagram records nothing and keeps it open', async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(diagram, harness.call());

      const approved = await harness.artifacts.approve(
        { artifactId: diagram.artifactId, revision: 1 },
        harness.call(),
      );

      assert.equal(approved?.state, 'open');
      assert.deepEqual(types(harness), ['artifacts.created/v1']);
    } finally {
      await harness.close();
    }
  });

  test('under request, awaitApproval on a diagram resolves at once', {
    timeout: 2000,
  }, async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(diagram, harness.call());

      const released = await harness.artifacts.awaitApproval(
        { artifactId: diagram.artifactId, revision: 1 },
        harness.call(),
      );

      assert.equal(released?.revision, 1);
    } finally {
      await harness.close();
    }
  });

  test('under request, apply does not refuse a diagram nobody approved', async () => {
    const harness = await artifactsHarness({ policy: 'request' });

    try {
      await harness.artifacts.create(diagram, harness.call());

      await harness.artifacts.apply(
        {
          artifactId: diagram.artifactId,
          revision: 1,
          files: ['docs/flow.drawio'],
        },
        harness.call(),
      );

      assert.deepEqual(types(harness), [
        'artifacts.created/v1',
        'artifacts.applied/v1',
      ]);
    } finally {
      await harness.close();
    }
  });

  test('with diagram removed from exemptKinds, a diagram is gated again', async () => {
    const harness = await artifactsHarness();
    const apply = {
      artifactId: diagram.artifactId,
      revision: 1,
      files: ['docs/flow.drawio'],
    };

    harness.settings.values.set(artifactReviewPolicy.id, {
      policy: 'request',
      exemptKinds: [],
    });

    try {
      await harness.artifacts.create(diagram, harness.call());

      await assert.rejects(harness.artifacts.apply(apply, harness.call()), {
        code: 'invalid_input',
      });
      assert.equal(
        (
          await harness.artifacts.awaitApproval(
            { artifactId: diagram.artifactId, revision: 1, timeoutMs: 5 },
            harness.call(),
          )
        )?.state,
        'open',
      );

      const approved = await harness.artifacts.approve(
        { artifactId: diagram.artifactId, revision: 1 },
        harness.call(),
      );

      assert.equal(approved?.state, 'approved');
      assert.deepEqual(types(harness), [
        'artifacts.created/v1',
        'artifacts.approved/v1',
      ]);
    } finally {
      await harness.close();
    }
  });

  test('setPolicy keeps the stored exemptKinds', async () => {
    const harness = await artifactsHarness();

    harness.settings.values.set(artifactReviewPolicy.id, {
      policy: 'request',
      exemptKinds: ['x'],
    });

    try {
      await harness.artifacts.setPolicy({ policy: 'proceed' }, harness.call());

      assert.deepEqual(await harness.artifacts.policy(harness.call()), {
        policy: 'proceed',
        exemptKinds: ['x'],
      });
    } finally {
      await harness.close();
    }
  });
});
