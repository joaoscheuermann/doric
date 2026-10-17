// `artifacts/v1`: identity, immutable revisions, the entries and bytes they
// name, the events they publish and the work copy they leave in the Project's
// sandbox — born Git-ignored, always under `.doric/`, and never half-written.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const base64 = (value: string | Uint8Array): string =>
  Buffer.from(value).toString('base64');

const decoded = (value: string | undefined): string =>
  Buffer.from(value ?? '', 'base64').toString('utf8');

/** The entry and the file of one payload file, as a caller sends both. */
const payloadFile = (path: string, content: string | Uint8Array) => ({
  entry: { path, sha256: sha256(content) },
  file: { path, base64: base64(content) },
});

/** Every file below the workspace copy, relative to it. */
const filesUnder = async (root: string): Promise<string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();

const checkout = {
  artifactId: 'checkout-7f3a',
  kind: 'preview',
  title: 'Checkout',
  targets: [target],
};

describe('artifacts/v1.create', () => {
  test('publishes artifacts.created/v1 with the entries and answers revision 1', async () => {
    const harness = await artifactsHarness();
    const markup = payloadFile('index.html', '<h1>Checkout</h1>');

    try {
      const created = await harness.artifacts.create(
        {
          ...checkout,
          title: 'Checkout with the pay button',
          source: 'html',
          path: 'src/checkout/Checkout.tsx',
          entry: 'index.html',
          notes: 'Keep the copy short.',
          entries: [markup.entry],
          files: [markup.file],
        },
        harness.call(),
      );

      assert.equal(created.artifactId, 'checkout-7f3a');
      assert.equal(created.revision, 1);
      assert.equal(created.revisions, 1);
      assert.equal(created.state, 'open');
      assert.deepEqual(created.entries, [markup.entry]);

      assert.deepEqual(
        harness.events.appended.map((entry) => entry.type),
        ['artifacts.created/v1'],
      );
      // The durable event's body is the contract replay reads.
      assert.deepEqual(harness.events.appended[0]?.payload, {
        artifactId: 'checkout-7f3a',
        revision: 1,
        kind: 'preview',
        title: 'Checkout with the pay button',
        targets: [target],
        entries: [markup.entry],
        source: 'html',
        path: 'src/checkout/Checkout.tsx',
        entry: 'index.html',
        notes: 'Keep the copy short.',
      });
      assert.equal(
        JSON.stringify(harness.events.appended[0]?.payload).includes(
          markup.file.base64,
        ),
        false,
        'the durable event never carries bytes',
      );
      assert.equal(
        harness.events.appended[0]?.call.scope?.promptId,
        promptScope.promptId,
      );
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
      await harness.artifacts.create(checkout, harness.call());

      await assert.rejects(harness.artifacts.create(checkout, harness.call()), {
        code: 'invalid_input',
      });
      assert.equal(harness.events.appended.length, 1);
    } finally {
      await harness.close();
    }
  });

  test('refuses an id that is not one, before writing anything', async () => {
    const harness = await artifactsHarness();

    try {
      for (const artifactId of ['../../../tmp/x', 'Checkout', 'a/b']) {
        // The input schema refuses it at the boundary, synchronously.
        await assert.rejects(
          async () =>
            harness.artifacts.create(
              { ...checkout, artifactId },
              harness.call(),
            ),
          { code: 'invalid_input' },
          artifactId,
        );
      }

      assert.deepEqual(await filesUnder(harness.root), []);
    } finally {
      await harness.close();
    }
  });

  test('serves the bytes it wrote, binary included, verified against their hashes', async () => {
    const harness = await artifactsHarness();
    // Bytes that are not UTF-8: a decode to text would mangle them.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 1]);
    const image = payloadFile('shot.png', png);
    const markup = payloadFile('index.html', '<img src="shot.png">');

    try {
      await harness.artifacts.create(
        {
          ...checkout,
          entries: [markup.entry, image.entry],
          files: [markup.file, image.file],
        },
        harness.call(),
      );

      const read = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.deepEqual(
        read?.entries.map((entry) => [entry.path, entry.base64]),
        [
          ['index.html', markup.file.base64],
          ['shot.png', image.file.base64],
        ],
      );
    } finally {
      await harness.close();
    }
  });

  test('refuses file bytes that do not hash to their entry, or name no entry', async () => {
    const harness = await artifactsHarness();
    const markup = payloadFile('index.html', '<h1>Checkout</h1>');

    try {
      await assert.rejects(
        harness.artifacts.create(
          {
            ...checkout,
            entries: [{ path: 'index.html', sha256: sha256('other') }],
            files: [markup.file],
          },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );
      await assert.rejects(
        harness.artifacts.create(
          { ...checkout, entries: [], files: [markup.file] },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );

      assert.equal(harness.events.appended.length, 0);
      assert.deepEqual(await filesUnder(harness.root), []);
    } finally {
      await harness.close();
    }
  });

  test('refuses entry paths that would leave the artifact directory', async () => {
    const harness = await artifactsHarness();

    try {
      for (const path of [
        '../../../escape.html',
        '/etc/passwd',
        'a/../../b.html',
        'a\\..\\b.html',
        'a//b.html',
        './index.html',
        'nul\0.html',
        '',
      ]) {
        const escaping = payloadFile(path, 'x');

        await assert.rejects(
          async () =>
            harness.artifacts.create(
              {
                ...checkout,
                entries: [escaping.entry],
                files: [escaping.file],
              },
              harness.call(),
            ),
          { code: 'invalid_input' },
          JSON.stringify(path),
        );
      }

      assert.deepEqual(await filesUnder(harness.root), []);
    } finally {
      await harness.close();
    }
  });

  test('refuses an entry path a kind materialization names outside the revision', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.kinds.register(
        {
          id: 'diagram',
          materialize: () => ({
            entries: [{ path: '../../outside.svg', sha256: sha256('x') }],
            files: [{ path: '../../outside.svg', base64: base64('x') }],
          }),
        },
        harness.call(),
      );

      await assert.rejects(
        harness.artifacts.create(
          {
            artifactId: 'flow-1',
            kind: 'diagram',
            title: 'Flow',
            payload: {},
          },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );
      assert.deepEqual(await filesUnder(harness.root), []);
    } finally {
      await harness.close();
    }
  });

  test('materializes the payload as the kind schema parsed it', async () => {
    const harness = await artifactsHarness();
    const svgOf = (label: string) => `<svg>${label}</svg>`;

    try {
      await harness.kinds.register(
        {
          id: 'diagram',
          title: 'Diagram',
          // A default the caller leaves out: the materialization must see it.
          payload: z.object({ label: z.string().default('Flow') }).strict(),
          materialize: (input) => {
            const { label } = input.payload as { label: string };
            const svg = payloadFile('diagram.svg', svgOf(label));

            return {
              entries: [svg.entry],
              targets: [{ path: `docs/${label}.md` }],
              files: [svg.file],
            };
          },
        },
        harness.call(),
      );

      const created = await harness.artifacts.create(
        {
          artifactId: 'flow-1',
          kind: 'diagram',
          title: 'The flow',
          payload: {},
        },
        harness.call(),
      );

      assert.deepEqual(created.targets, [{ path: 'docs/Flow.md' }]);

      const read = await harness.artifacts.read(
        { artifactId: 'flow-1' },
        harness.call(),
      );

      assert.equal(decoded(read?.entries[0]?.base64), svgOf('Flow'));
      // The event names the payload as parsed, so replay sees the default too.
      assert.deepEqual(harness.events.appended[0]?.payload.payload, {
        label: 'Flow',
      });
    } finally {
      await harness.close();
    }
  });

  test('refuses a payload the kind schema refuses, and a kind nobody registered', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.kinds.register(
        {
          id: 'diagram',
          payload: z.object({ label: z.string().min(1) }).strict(),
        },
        harness.call(),
      );

      await assert.rejects(
        harness.artifacts.create(
          { artifactId: 'flow-1', kind: 'diagram', title: 'F', payload: {} },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );
      await assert.rejects(
        harness.artifacts.create(
          { artifactId: 'flow-2', kind: 'ghost', title: 'G', payload: {} },
          harness.call(),
        ),
        { code: 'invalid_input' },
      );

      assert.equal(harness.events.appended.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('refuses a call without the prompt scope its event needs, writing nothing', async () => {
    const harness = await artifactsHarness();
    const markup = payloadFile('index.html', '<h1>x</h1>');

    try {
      await assert.rejects(
        harness.artifacts.create(
          { ...checkout, entries: [markup.entry], files: [markup.file] },
          harness.call({ projectId: 'project-1', threadId: 'thread-1' }),
        ),
        { code: 'invalid_scope' },
      );

      assert.deepEqual(await filesUnder(harness.root), []);
      assert.equal(
        await harness.artifacts.read(
          { artifactId: 'checkout-7f3a' },
          harness.call(),
        ),
        undefined,
      );
    } finally {
      await harness.close();
    }
  });

  test('leaves no artifact behind when the event cannot be appended', async () => {
    const harness = await artifactsHarness();
    const markup = payloadFile('index.html', '<h1>x</h1>');

    try {
      harness.events.failNext = new Error('the log is down');

      await assert.rejects(
        harness.artifacts.create(
          { ...checkout, entries: [markup.entry], files: [markup.file] },
          harness.call(),
        ),
        /the log is down/,
      );

      assert.equal(
        await harness.artifacts.read(
          { artifactId: 'checkout-7f3a' },
          harness.call(),
        ),
        undefined,
      );
      // The id is free again: nothing half-written claims it.
      await harness.artifacts.create(checkout, harness.call());
    } finally {
      await harness.close();
    }
  });

  test('borns .doric/ Git-ignored and keeps an ignore the user changed', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(checkout, harness.call());

      assert.equal(
        await readFile(join(harness.root, '.doric/.gitignore'), 'utf8'),
        '*\n',
      );

      await writeFile(
        join(harness.root, '.doric/.gitignore'),
        '*\n!.doric/artifacts/\n',
        'utf8',
      );
      await harness.artifacts.create(
        { ...checkout, artifactId: 'receipt-11aa' },
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

  test('answers the lease state instead of reaching a sandbox it does not hold', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(checkout, harness.call());
      harness.setLease('pending');

      assert.equal(
        await harness.artifacts.read(
          { artifactId: 'checkout-7f3a' },
          harness.call(),
        ),
        undefined,
      );
      assert.deepEqual(await harness.artifacts.list({}, harness.call()), []);
      await assert.rejects(
        harness.artifacts.create(
          { ...checkout, artifactId: 'receipt-11aa' },
          harness.call(),
        ),
        (error: { code?: string; details?: { lease?: string } }) =>
          error.code === 'unavailable' && error.details?.lease === 'pending',
      );
    } finally {
      await harness.close();
    }
  });
});

describe('artifacts/v1.revise', () => {
  test('adds a revision, carries over what it does not declare, and keeps the previous one readable', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(
        { ...checkout, source: 'html', entry: 'index.html' },
        harness.call(),
      );

      const revised = await harness.artifacts.revise(
        { artifactId: 'checkout-7f3a', changeNote: 'Smaller button' },
        harness.call(),
      );

      assert.equal(revised.revision, 2);
      assert.equal(revised.revisions, 2);
      assert.deepEqual(revised.targets, [target]);
      assert.equal(revised.source, 'html');
      assert.equal(revised.entry, 'index.html');

      const first = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a', revision: 1 },
        harness.call(),
      );

      assert.equal(first?.revision, 1);
      assert.equal(first?.revisions, 2);

      // Kind and title travel too: a Thread that revises an artifact another
      // Thread created has no created event to read them from.
      assert.deepEqual(harness.events.appended[1]?.payload, {
        artifactId: 'checkout-7f3a',
        revision: 2,
        kind: 'preview',
        title: 'Checkout',
        changeNote: 'Smaller button',
        targets: [target],
        entries: [],
      });
    } finally {
      await harness.close();
    }
  });

  test('moves the anchors when the revision declares new ones', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(checkout, harness.call());

      const moved = {
        path: 'src/checkout/PayButton.tsx',
        lines: [7, 9] as const,
      };

      await harness.artifacts.revise(
        { artifactId: 'checkout-7f3a', targets: [moved] },
        harness.call(),
      );

      const [first, second] = await harness.artifacts.revisions(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.deepEqual(first?.targets, [target]);
      assert.deepEqual(second?.targets, [moved]);
    } finally {
      await harness.close();
    }
  });

  test('keeps every revision its own bytes', async () => {
    const harness = await artifactsHarness();
    const first = payloadFile('index.html', '<h1>Checkout</h1>');
    const second = payloadFile('index.html', '<h1>Checkout, smaller</h1>');

    try {
      await harness.artifacts.create(
        { ...checkout, entries: [first.entry], files: [first.file] },
        harness.call(),
      );
      await harness.artifacts.revise(
        {
          artifactId: 'checkout-7f3a',
          entries: [second.entry],
          files: [second.file],
        },
        harness.call(),
      );

      const older = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a', revision: 1 },
        harness.call(),
      );
      const newest = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(decoded(older?.entries[0]?.base64), '<h1>Checkout</h1>');
      assert.equal(
        decoded(newest?.entries[0]?.base64),
        '<h1>Checkout, smaller</h1>',
      );
    } finally {
      await harness.close();
    }
  });

  test('serves carried-over entries with the bytes of the revision that wrote them', async () => {
    const harness = await artifactsHarness();
    const markup = payloadFile('index.html', '<h1>Checkout</h1>');

    try {
      await harness.artifacts.create(
        { ...checkout, entries: [markup.entry], files: [markup.file] },
        harness.call(),
      );
      await harness.artifacts.revise(
        { artifactId: 'checkout-7f3a', changeNote: 'Anchors only' },
        harness.call(),
      );

      const newest = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(newest?.revision, 2);
      assert.equal(decoded(newest?.entries[0]?.base64), '<h1>Checkout</h1>');
    } finally {
      await harness.close();
    }
  });

  test('refuses entry paths that would leave the artifact directory', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(checkout, harness.call());

      const escaping = payloadFile('../../../../escape.html', 'x');

      await assert.rejects(
        async () =>
          harness.artifacts.revise(
            {
              artifactId: 'checkout-7f3a',
              entries: [escaping.entry],
              files: [escaping.file],
            },
            harness.call(),
          ),
        { code: 'invalid_input' },
      );
      assert.equal(
        (await filesUnder(harness.root)).every((path) =>
          path.startsWith('.doric/'),
        ),
        true,
      );
    } finally {
      await harness.close();
    }
  });

  test('leaves the artifact at its previous revision when the event cannot be appended', async () => {
    const harness = await artifactsHarness();
    const second = payloadFile('index.html', '<h1>2</h1>');

    try {
      await harness.artifacts.create(checkout, harness.call());
      harness.events.failNext = new Error('the log is down');

      await assert.rejects(
        harness.artifacts.revise(
          {
            artifactId: 'checkout-7f3a',
            entries: [second.entry],
            files: [second.file],
          },
          harness.call(),
        ),
        /the log is down/,
      );

      const newest = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(newest?.revision, 1);
      assert.equal(newest?.revisions, 1);

      // The next revise takes revision 2, the number the failure never used.
      const retried = await harness.artifacts.revise(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(retried.revision, 2);
    } finally {
      await harness.close();
    }
  });

  test('gives concurrent revisions distinct numbers', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(checkout, harness.call());

      const revised = await Promise.all(
        ['a', 'b', 'c'].map((changeNote) =>
          harness.artifacts.revise(
            { artifactId: 'checkout-7f3a', changeNote },
            harness.call(),
          ),
        ),
      );

      assert.deepEqual(
        revised.map((record) => record.revision).sort(),
        [2, 3, 4],
      );
      assert.equal(
        (
          await harness.artifacts.revisions(
            { artifactId: 'checkout-7f3a' },
            harness.call(),
          )
        ).length,
        4,
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

      await harness.artifacts.create(checkout, harness.call());

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

  test('lists the Thread of the call, an asked Thread, or the whole Project', async () => {
    const harness = await artifactsHarness();
    const otherThread = {
      projectId: 'project-1',
      threadId: 'thread-2',
      promptId: 'prompt-2',
    };

    try {
      await harness.artifacts.create(checkout, harness.call());
      await harness.artifacts.create(
        { ...checkout, artifactId: 'receipt-11aa' },
        harness.call(otherThread),
      );

      const ids = async (
        input: { readonly threadId?: string },
        scope = promptScope,
      ) =>
        (await harness.artifacts.list(input, harness.call(scope))).map(
          (entry) => entry.artifactId,
        );

      assert.deepEqual(await ids({}), ['checkout-7f3a']);
      assert.deepEqual(await ids({ threadId: 'thread-2' }), ['receipt-11aa']);
      assert.deepEqual(await ids({}, { projectId: 'project-1' }), [
        'checkout-7f3a',
        'receipt-11aa',
      ]);
    } finally {
      await harness.close();
    }
  });

  test('keeps listing when one manifest is broken or from a future layout', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(checkout, harness.call());

      for (const [id, body] of [
        ['broken-1', '{ not json'],
        [
          'future-1',
          JSON.stringify({ manifestVersion: 9, artifactId: 'future-1' }),
        ],
      ] as const) {
        await mkdir(join(harness.root, '.doric/artifacts', id), {
          recursive: true,
        });
        await writeFile(
          join(harness.root, '.doric/artifacts', id, 'artifact.json'),
          body,
          'utf8',
        );
      }

      assert.deepEqual(
        (await harness.artifacts.list({}, harness.call())).map(
          (entry) => entry.artifactId,
        ),
        ['checkout-7f3a'],
      );
      assert.equal(
        await harness.artifacts.read(
          { artifactId: 'broken-1' },
          harness.call(),
        ),
        undefined,
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
        { ...checkout, targets: [odd] },
        harness.call(),
      );

      const read = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.deepEqual(read?.targets, [odd]);
      assert.deepEqual(harness.events.appended[0]?.payload.targets, [odd]);
    } finally {
      await harness.close();
    }
  });

  test('reads a work copy of the first layout, its approval included', async () => {
    const harness = await artifactsHarness();

    try {
      // A work copy from an earlier generation: entries at the artifact root
      // and one artifact-wide approval naming its revision.
      const markup = '<h1>From before</h1>';
      const dir = join(harness.root, '.doric/artifacts/checkout-7f3a');

      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'index.html'), markup, 'utf8');
      await writeFile(
        join(dir, 'artifact.json'),
        JSON.stringify({
          manifestVersion: 1,
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          title: 'Checkout',
          state: 'approved',
          approvedRevision: 1,
          createdAt: '2024-01-01T00:00:00Z',
          revisions: [
            {
              revision: 1,
              targets: [],
              entries: [{ path: 'index.html', sha256: sha256(markup) }],
              createdAt: '2024-01-01T00:00:00Z',
            },
          ],
        }),
        'utf8',
      );

      const read = await harness.artifacts.read(
        { artifactId: 'checkout-7f3a' },
        harness.call(),
      );

      assert.equal(read?.title, 'Checkout');
      assert.equal(read?.state, 'approved');
      assert.equal(decoded(read?.entries[0]?.base64), markup);
    } finally {
      await harness.close();
    }
  });
});

describe('artifacts/v1.apply', () => {
  test('publishes artifacts.applied/v1 for a revision that exists', async () => {
    const harness = await artifactsHarness();

    try {
      await harness.artifacts.create(checkout, harness.call());

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
