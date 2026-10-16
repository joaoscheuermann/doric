// `artifact.kind/v1`: the name a bundle declares its kind with, before any
// artifact of it exists, plus the kind's own providers — the zod schema of
// its payload, its materialization, the `blockType` of its body and the
// `bodyTag` the frame mounts it with (and whether the body draws the header).
// A registration is a `Disposable` that
// lives as long as the registering generation, and a bundle's next generation
// replaces its own declaration.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { createArtifactKindRegistry } from '../src/host/kinds.js';
import { artifactsHarness } from './support/harness.js';

const preview = {
  id: 'preview',
  title: 'Preview',
  blockType: 'papercraft.preview/v1',
  bodyTag: 'papercraft-preview-body',
  header: 'body',
} as const;

describe('artifact.kind/v1', () => {
  test('lists the kinds in force, in registration order, without the providers', async () => {
    const harness = await artifactsHarness();

    try {
      assert.deepEqual(await harness.kinds.list(harness.call()), []);

      await harness.kinds.register(
        {
          ...preview,
          payload: z.object({ label: z.string() }).strict(),
          materialize: () => ({ entries: [] }),
        },
        harness.call(),
      );
      await harness.kinds.register({ id: 'screen.recording' }, harness.call());

      assert.deepEqual(await harness.kinds.list(harness.call()), [
        preview,
        { id: 'screen.recording' },
      ]);
    } finally {
      await harness.close();
    }
  });

  test('forgets a kind once its registration is disposed', async () => {
    const harness = await artifactsHarness();

    try {
      const registration = await harness.kinds.register(
        preview,
        harness.call(),
      );

      registration.dispose();

      assert.deepEqual(await harness.kinds.list(harness.call()), []);
    } finally {
      await harness.close();
    }
  });

  test('lets the next generation change its title and block type, and outlive the previous one', async () => {
    const harness = await artifactsHarness();

    try {
      const previous = await harness.kinds.register(preview, harness.call());
      // The next generation registers before the previous one is disposed.
      await harness.kinds.register(
        { ...preview, title: 'Live preview', blockType: 'papercraft.body/v2' },
        harness.call(),
      );

      previous.dispose();

      assert.deepEqual(await harness.kinds.list(harness.call()), [
        {
          ...preview,
          title: 'Live preview',
          blockType: 'papercraft.body/v2',
        },
      ]);
    } finally {
      await harness.close();
    }
  });

  test('refuses another bundle claiming a kind id in use', () => {
    const registry = createArtifactKindRegistry();
    const held = registry.register(preview, 'papercraft');

    assert.throws(() => registry.register(preview, 'other'), {
      code: 'registration_conflict',
    });

    held.dispose();

    // Once released, the id is free for whoever registers it next.
    registry.register(preview, 'other');
    assert.equal(registry.find('preview')?.title, 'Preview');
  });

  test('refuses a kind id that is not one', async () => {
    const harness = await artifactsHarness();

    try {
      for (const id of ['Preview', 'pre view']) {
        await assert.rejects(harness.kinds.register({ id }, harness.call()), {
          code: 'invalid_input',
        });
      }
    } finally {
      await harness.close();
    }
  });
});
