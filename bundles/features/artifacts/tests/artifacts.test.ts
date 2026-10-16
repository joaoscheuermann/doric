// `artifacts/v1`: identity, immutable revisions, the entries and bytes they
// name, the events they publish and the work copy they leave in the Project's
// sandbox — born Git-ignored.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { z } from 'zod';

import {
  type ArtifactTarget,
  artifactsHarness,
  promptScope,
} from './support/harness.js';

const target: ArtifactTarget = {
  path: 'src/checkout/Checkout.tsx',
  line: 42,
  snippet: '<PayButton />',
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const base64 = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64');

const storedManifest = async (
  root: string,
  artifactId: string,
): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      join(root, '.doric/artifacts', artifactId, 'artifact.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;

describe('artifacts/v1.create', () => {
  test('writes revision 1, stores it and publishes artifacts.created/v1 with the entries', async () => {
    const harness = await artifactsHarness();

    try {
      const created = await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout with the pay button',
          targets: [target],
          source: 'html',
          path: 'src/checkout/Checkout.tsx',
          entry: 'index.html',
          notes: 'Keep the copy short.',
        },
        harness.call(),
      );

      assert.deepEqual(created, {
        artifactId: 'checkout-7f3a',
        kind: 'preview',
        title: 'Checkout with the pay button',
        revision: 1,
        revisions: 1,
        targets: [target],
        entries: [],
        source: 'html',
        path: 'src/checkout/Checkout.tsx',
        entry: 'index.html',
        notes: 'Keep the copy short.',
        state: 'open',
        createdAt: created.createdAt,
        // The harness's caller is this bundle, so the record names it.
        createdBy: 'artifacts',
      });
      assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);

      assert.equal(harness.events.appended.length, 1);

      const [appended] = harness.events.appended;

      assert.equal(appended?.type, 'artifacts.created/v1');
      assert.deepEqual(appended?.payload, {
        artifactId: 'checkout-7f3a',
        revision: 1,
        kind: 'preview',
        title: 'Checkout with the pay button',
        targets: [target],
        // Entries — never bytes — travel with the event.
        entries: [],
        source: 'html',
        path: 'src/checkout/Checkout.tsx',
        entry: 'index.html',
        notes: 'Keep the copy short.',
      });
      assert.equal(
        JSON.stringify(appended?.payload).includes('base64'),
        false,
        'the durable event never carries bytes',
      );
      assert.equal(appended?.call.scope?.threadId, promptScope.threadId);
      assert.equal(appended?.call.scope?.promptId, promptScope.promptId);

      const stored = await storedManifest(harness.root, 'checkout-7f3a');

      assert.equal(stored.manifestVersion, 1);
      assert.equal(stored.threadId, promptScope.threadId);
      assert.equal(stored.promptId, promptScope.promptId);
      assert.equal(stored.createdBy, 'artifacts');
      assert.deepEqual((stored.revisions as readonly unknown[]).length, 1);
      const [revision] = stored.revisions as readonly {
        readonly revision: unknown;
        readonly entries: unknown;
      }[];

      assert.equal(revision?.revision, 1);
      assert.deepEqual(revision?.entries, []);
    } finally {
      await harness.close();
    }
  });

  test('derives a lowercase slug plus a short suffix when no id is given', async () => {
    const harness = await artifactsHarness();

    try {
      const created = await harness.artifacts.create(
        { kind: 'preview', title: 'Índice de Pedidos', targets: [] },
        harness.call(),
      );

      assert.match(created.artifactId, /^indice-de-pedidos-[0-9a-f]{4}$/);
    } finally {
      await harness.close();
    }
  });

  test('refuses an id that already exists', async () => {
    const harness = await artifactsHarness();

    try {
      const input = {
        artifactId: 'checkout-7f3a',
        kind: 'preview',
        title: 'Checkout',
        targets: [],
      };

      await harness.artifacts.create(input, harness.call());

      await assert.rejects(harness.artifacts.create(input, harness.call()), {
        code: 'invalid_input',
      });
      assert.equal(harness.events.appended.length, 1);
    } finally {
      await harness.close();
    }
  });

  test('writes the entry bytes into the work copy, verified against their hashes', async () => {
    const harness = await artifactsHarness();
    const markup = '<h1>Checkout</h1>';

    try {
      const created = await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [target],
          entries: [{ path: 'index.html', sha256: sha256(markup) }],
          files: [{ path: 'index.html', base64: base64(markup) }],
        },
        harness.call(),
      );

      assert.deepEqual(created.entries, [
        { path: 'index.html', sha256: sha256(markup) },
      ]);

      // The bytes are in the work copy, beside the manifest.
      const stored = await readFile(
        join(harness.root, '.doric/artifacts/checkout-7f3a/index.html'),
        'utf8',
      );

      assert.equal(stored, markup);

      // The event carries the entries only.
      const payload = harness.events.appended[0]?.payload;

      assert.equal(JSON.stringify(payload).includes(base64(markup)), false);
      assert.deepEqual((payload as { entries: unknown }).entries, [
        { path: 'index.html', sha256: sha256(markup) },
      ]);

      // `read` serves the entry in base64, in the mold of
      // `doric.catalog/v1.artifact`, and the hash still verifies.
      const read = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(read?.revision, 1);
      assert.equal(read?.entries.length, 1);
      assert.equal(read?.entries[0]?.path, 'index.html');
      assert.equal(read?.entries[0]?.sha256, sha256(markup));
      assert.equal(
        Buffer.from(read?.entries[0]?.base64 ?? '', 'base64').toString('utf8'),
        markup,
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses file bytes that do not hash to the entry they name', async () => {
    const harness = await artifactsHarness();

    try {
      await assert.rejects(
        harness.artifacts.create(
          {
            artifactId: 'checkout-7f3a',
            kind: 'preview',
            title: 'Checkout',
            targets: [],
            entries: [{ path: 'index.html', sha256: sha256('other') }],
            files: [
              { path: 'index.html', base64: base64('<h1>Checkout</h1>') },
            ],
          },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );

      // Nothing was published: the registry refused before the event.
      assert.equal(harness.events.appended.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('refuses file bytes that name no entry of the revision', async () => {
    const harness = await artifactsHarness();

    try {
      await assert.rejects(
        harness.artifacts.create(
          {
            artifactId: 'checkout-7f3a',
            kind: 'preview',
            title: 'Checkout',
            targets: [],
            entries: [],
            files: [{ path: 'index.html', base64: base64('<h1>x</h1>') }],
          },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );
    } finally {
      await harness.close();
    }
  });

  test('materializes a payload through the kind the caller registered', async () => {
    const harness = await artifactsHarness();

    try {
      // A kind with its own payload schema and materialization, as a bundle
      // that owns an artifact kind declares it at activation.
      const svgOf = (label: string) => `<svg>${label}</svg>`;

      await harness.kinds.register({
        id: 'diagram',
        title: 'Diagram',
        payload: z.object({ label: z.string().min(1) }).strict(),
        materialize: (input) => {
          const { label } = input.payload as { label: string };
          const markup = svgOf(label);

          return {
            entries: [{ path: 'diagram.svg', sha256: sha256(markup) }],
            targets: [{ path: `docs/${label}.md` }],
            files: [{ path: 'diagram.svg', base64: base64(markup) }],
          };
        },
      });

      const created = await harness.artifacts.create(
        {
          artifactId: 'flow-1',
          kind: 'diagram',
          title: 'The flow',
          // No anchors: the kind's own materialization declares them.
          payload: { label: 'Flow' },
        },
        harness.call(),
      );

      // The materialization's entries and anchors became the revision's.
      assert.deepEqual(created.entries, [
        { path: 'diagram.svg', sha256: sha256(svgOf('Flow')) },
      ]);
      assert.deepEqual(created.targets, [{ path: 'docs/Flow.md' }]);

      const stored = await storedManifest(harness.root, 'flow-1');
      const [revision] = stored.revisions as readonly {
        readonly entries: unknown;
      }[];

      assert.deepEqual(revision?.entries, created.entries);

      const read = await harness.artifacts.read(
        { artifactId: 'flow-1' },
        harness.call(),
      );

      assert.equal(
        Buffer.from(read?.entries[0]?.base64 ?? '', 'base64').toString('utf8'),
        svgOf('Flow'),
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses a payload the kind schema refuses, and a kind nobody registered', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.kinds.register({
        id: 'diagram',
        payload: z.object({ label: z.string().min(1) }).strict(),
      });

      await assert.rejects(
        harness.artifacts.create(
          {
            artifactId: 'flow-1',
            kind: 'diagram',
            title: 'The flow',
            targets: [],
            payload: {},
          },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );

      await assert.rejects(
        harness.artifacts.create(
          {
            artifactId: 'flow-2',
            kind: 'ghost',
            title: 'A ghost kind',
            targets: [],
            payload: { anything: true },
          },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );

      assert.equal(harness.events.appended.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('borns .doric/ Git-ignored', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [],
        },
        harness.call(),
      );

      assert.equal(
        await readFile(join(harness.root, '.doric/.gitignore'), 'utf8'),
        '*\n',
      );

      // The second write keeps the existing ignore as it is.
      await writeFile(
        join(harness.root, '.doric/.gitignore'),
        '*\n!.doric/artifacts/\n',
        'utf8',
      );
      await harness.artifacts.create(
        {
          artifactId: 'receipt-11aa',
          kind: 'preview',
          title: 'Receipt',
          targets: [],
        },
        harness.call(),
      );

      assert.equal(
        await readFile(join(harness.root, '.doric/.gitignore'), 'utf8'),
        '*\n!.doric/artifacts/\n',
      );
    } finally {
      await harness.close();
    }
  });
});

describe('artifacts/v1.revise', () => {
  test('adds a revision and keeps the previous one readable', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [target],
          source: 'html',
          entry: 'index.html',
        },
        harness.call(),
      );

      const revised = await harness.artifacts.revise(
        { artifactId: 'checkout-7f3a', changeNote: 'Smaller button' },
        harness.call(),
      );

      assert.equal(revised.revision, 2);
      assert.equal(revised.revisions, 2);
      // Nothing said about the payload carries over from revision 1.
      assert.deepEqual(revised.targets, [target]);
      assert.equal(revised.source, 'html');
      assert.equal(revised.entry, 'index.html');

      const first = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a', revision: 1 },
        harness.call(),
      );

      assert.equal(first?.revision, 1);
      assert.equal(first?.revisions, 2);
      assert.deepEqual(first?.targets, [target]);

      const newest = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(newest?.revision, 2);

      const events = harness.events.appended.map((entry) => entry.type);

      assert.deepEqual(events, [
        'artifacts.created/v1',
        'artifacts.revised/v1',
      ]);
      // The revised event carries the revision's resolved anchors and
      // entries — the log is the durable truth.
      assert.deepEqual(harness.events.appended[1]?.payload, {
        artifactId: 'checkout-7f3a',
        revision: 2,
        changeNote: 'Smaller button',
        targets: [target],
        entries: [],
      });

      const stored = await storedManifest(harness.root, 'checkout-7f3a');

      assert.equal((stored.revisions as readonly unknown[]).length, 2);
      const [firstRevision, secondRevision] = stored.revisions as readonly {
        readonly revision: unknown;
      }[];

      assert.equal(firstRevision?.revision, 1);
      assert.equal(secondRevision?.revision, 2);
    } finally {
      await harness.close();
    }
  });

  test('moves the anchors when the revision declares new ones', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [target],
        },
        harness.call(),
      );

      const moved = { path: 'src/checkout/PayButton.tsx', line: 7 };

      await harness.artifacts.revise(
        { artifactId: 'checkout-7f3a', targets: [moved] },
        harness.call(),
      );

      const newest = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.deepEqual(newest?.targets, [moved]);
      assert.deepEqual(
        (
          await harness.artifacts.read(
            { artifactId: 'checkout-7f3a', revision: 1 },
            harness.call(),
          )
        )?.targets,
        [target],
      );
    } finally {
      await harness.close();
    }
  });

  test('carries the entries over and replaces the bytes the revision names', async () => {
    const harness = await artifactsHarness();
    const firstMarkup = '<h1>Checkout</h1>';
    const secondMarkup = '<h1>Checkout, smaller</h1>';

    try {
      await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [],
          entries: [{ path: 'index.html', sha256: sha256(firstMarkup) }],
          files: [{ path: 'index.html', base64: base64(firstMarkup) }],
        },
        harness.call(),
      );

      await harness.artifacts.revise(
        {
          artifactId: 'checkout-7f3a',
          changeNote: 'Smaller',
          entries: [{ path: 'index.html', sha256: sha256(secondMarkup) }],
          files: [{ path: 'index.html', base64: base64(secondMarkup) }],
        },
        harness.call(),
      );

      // The work copy holds the newest payload; `read` still names both
      // revisions' entries, and the older one reads without bytes — a
      // derived kind reconstructs its form elsewhere.
      const newest = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(newest?.entries[0]?.sha256, sha256(secondMarkup));
      assert.equal(
        Buffer.from(newest?.entries[0]?.base64 ?? '', 'base64').toString(
          'utf8',
        ),
        secondMarkup,
      );

      const older = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a', revision: 1 },
        harness.call(),
      );

      assert.equal(older?.entries.length, 1);
      assert.equal(older?.entries[0]?.sha256, sha256(firstMarkup));
      assert.equal(
        'base64' in (older?.entries[0] ?? {}),
        false,
        'an entry whose bytes are gone reads without them',
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses an unknown artifact', async () => {
    const harness = await artifactsHarness();

    try {
      await assert.rejects(
        harness.artifacts.revise({ artifactId: 'missing' }, harness.call()),
        { code: 'invalid_input' },
      );
    } finally {
      await harness.close();
    }
  });
});

describe('artifacts/v1.read and list', () => {
  test('answers undefined for an unknown artifact or revision', async () => {
    const harness = await artifactsHarness();

    try {
      assert.equal(
        await harness.artifacts.read({ artifactId: 'missing' }, harness.call()),
        undefined,
      );

      await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [],
        },
        harness.call(),
      );

      assert.equal(
        await harness.artifacts.read(
          { artifactId: 'checkout-7f3a', revision: 9 },
          harness.call(),
        ),
        undefined,
      );
    } finally {
      await harness.close();
    }
  });

  test('lists the sandbox faithfully and filters by Thread', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [],
        },
        harness.call(),
      );
      await harness.artifacts.create(
        {
          artifactId: 'receipt-11aa',
          kind: 'preview',
          title: 'Receipt',
          targets: [],
        },
        harness.call({
          projectId: 'project-1',
          threadId: 'thread-2',
          promptId: 'prompt-2',
        }),
      );

      assert.deepEqual(
        (await harness.artifacts.list({}, harness.call())).map(
          (entry) => entry.artifactId,
        ),
        ['checkout-7f3a', 'receipt-11aa'],
      );
      assert.deepEqual(
        (
          await harness.artifacts.list({ threadId: 'thread-2' }, harness.call())
        ).map((entry) => entry.artifactId),
        ['receipt-11aa'],
      );
    } finally {
      await harness.close();
    }
  });

  test('keeps the anchors exactly as the caller declared them', async () => {
    const harness = await artifactsHarness();

    try {
      const odd: ArtifactTarget & { readonly extra: string } = {
        path: 'src//Weird Path.tsx',
        line: 0,
        snippet: 'const x = "  spaced  ";',
        extra: 'kept',
      };

      await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [odd],
        },
        harness.call(),
      );

      const stored = await storedManifest(harness.root, 'checkout-7f3a');
      const [revision] = stored.revisions as readonly {
        readonly targets: unknown;
      }[];

      assert.deepEqual(revision?.targets, [odd]);
      assert.deepEqual(harness.events.appended[0]?.payload.targets, [odd]);
    } finally {
      await harness.close();
    }
  });

  test('reads a manifest the sandbox already held, without the Git ignore of a later write', async () => {
    const harness = await artifactsHarness();

    try {
      // A work copy from an earlier generation, with an entry whose bytes
      // are still there: `read` verifies the hash before serving the bytes.
      const markup = '<h1>From before</h1>';

      await mkdir(join(harness.root, '.doric/artifacts/checkout-7f3a'), {
        recursive: true,
      });
      await writeFile(
        join(harness.root, '.doric/artifacts/checkout-7f3a/index.html'),
        markup,
        'utf8',
      );
      await writeFile(
        join(harness.root, '.doric/artifacts/checkout-7f3a/artifact.json'),
        `${JSON.stringify(
          {
            manifestVersion: 1,
            artifactId: 'checkout-7f3a',
            kind: 'preview',
            title: 'Checkout',
            state: 'open',
            createdAt: '2024-01-01T00:00:00Z',
            revisions: [
              {
                revision: 1,
                targets: [],
                entries: [{ path: 'index.html', sha256: sha256(markup) }],
                createdAt: '2024-01-01T00:00:00Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      const read = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(read?.title, 'Checkout');
      assert.equal(
        Buffer.from(read?.entries[0]?.base64 ?? '', 'base64').toString('utf8'),
        markup,
      );
    } finally {
      await harness.close();
    }
  });
});

describe('artifacts/v1.apply', () => {
  test('publishes artifacts.applied/v1 for a revision that exists', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          targets: [target],
        },
        harness.call(),
      );

      const applied = await harness.artifacts.apply(
        {
          artifactId: 'checkout-7f3a',
          revision: 1,
          files: ['src/checkout/Checkout.tsx'],
        },
        harness.call(),
      );

      assert.equal(applied?.revision, 1);
      assert.equal(harness.events.appended[1]?.type, 'artifacts.applied/v1');
      assert.deepEqual(harness.events.appended[1]?.payload, {
        artifactId: 'checkout-7f3a',
        revision: 1,
        files: ['src/checkout/Checkout.tsx'],
      });
      assert.equal(
        await harness.artifacts.apply(
          { artifactId: 'checkout-7f3a', revision: 4, files: [] },
          harness.call(),
        ),
        undefined,
      );
    } finally {
      await harness.close();
    }
  });
});
