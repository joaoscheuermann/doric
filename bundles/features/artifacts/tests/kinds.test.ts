// `artifact.kind/v1`: the name a bundle declares its kind with, before any
// artifact of it exists — and, since the audit, the kind's own providers: the
// zod schema of its payload, its materialization and the `blockType` its
// renderer draws.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { artifactsHarness } from './support/harness.js';

describe('artifact.kind/v1', () => {
  test('answers the kinds a bundle registered, in registration order, without the providers', async () => {
    const harness = await artifactsHarness();

    try {
      assert.deepEqual(await harness.kinds.list(harness.call()), []);

      await harness.kinds.register({
        id: 'preview',
        title: 'Preview',
        blockType: 'papercraft.preview/v1',
      });
      await harness.kinds.register({ id: 'screen.recording' }, harness.call());
      assert.deepEqual(await harness.kinds.list(harness.call()), [
        { id: 'preview', title: 'Preview', blockType: 'papercraft.preview/v1' },
        { id: 'screen.recording' },
      ]);
    } finally {
      await harness.close();
    }
  });

  test('is idempotent for the same declaration and refuses a different title or blockType', async () => {
    const harness = await artifactsHarness();

    try {
      const same = {
        id: 'preview',
        title: 'Preview',
        blockType: 'papercraft.preview/v1',
      };

      assert.deepEqual(await harness.kinds.register(same, harness.call()), {
        id: 'preview',
        title: 'Preview',
        blockType: 'papercraft.preview/v1',
      });

      // The providers are refreshed, not compared: a generation that
      // re-registers its kind hands the registry the functions it declared.
      await harness.kinds.register(
        {
          ...same,
          payload: z.object({ label: z.string() }).strict(),
          materialize: () => ({ entries: [] }),
        },
        harness.call(),
      );

      assert.deepEqual(await harness.kinds.list(harness.call()), [
        {
          id: 'preview',
          title: 'Preview',
          blockType: 'papercraft.preview/v1',
        },
      ]);

      await assert.rejects(
        harness.kinds.register(
          {
            ...same,
            title: 'Another',
            payload: z.object({}).strict(),
          },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );
      await assert.rejects(
        harness.kinds.register(
          { ...same, blockType: 'other.block/v1' },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses a kind id that is not one', async () => {
    const harness = await artifactsHarness();

    try {
      await assert.rejects(
        harness.kinds.register({ id: 'Preview' }, harness.call()),
        {
          code: 'invalid_input',
        },
      );
      await assert.rejects(
        harness.kinds.register({ id: 'pre view' }, harness.call()),
        {
          code: 'invalid_input',
        },
      );
    } finally {
      await harness.close();
    }
  });

  test('takes the kind payload schema and materialization it was given', async () => {
    const harness = await artifactsHarness();

    try {
      const payload = z.object({ label: z.string().min(1) }).strict();

      assert.deepEqual(
        await harness.kinds.register({
          id: 'diagram',
          title: 'Diagram',
          payload,
          materialize: () => ({ entries: [] }),
        }),
        { id: 'diagram', title: 'Diagram' },
      );
    } finally {
      await harness.close();
    }
  });
});
