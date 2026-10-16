// The `papercraft_preview` tool and the `preview` kind's materialization, at
// their public boundaries: the tool's input and the state it answers the
// model, and the writes it asks of `artifacts/v1` — the external registry.
//
// Contract matrix:
// - a source that cannot be read fails before anything is registered;
// - a new preview anchors to its own source unless targets are given, and the
//   registry receives the entries with the bytes that hash to them;
// - a component preview hands over its module, sheet and markup, and one that
//   does not compile fails before anything is registered;
// - the answer carries the unresolved comments of the artifact, with anchors;
// - `artifact_id` publishes the next revision of that preview, carrying over
//   title, source and path, and an unknown id is refused;
// - under `request` the answer says the approval is pending, at once;
// - the kind's materialize derives the same entries from the payload.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ArtifactRecord, Comment } from '../src/contracts/index.js';
import { previewKind } from '../src/host/kind.js';
import { deriveMarkup, sha256 } from '../src/host/previews.js';
import { tool } from '../src/host/tools/papercraft-preview.js';
import { servicesFor, testCall } from './support/services.js';

const SOURCE = '<button id="pay">Pagar</button>';

type Write = {
  readonly method: string;
  readonly input: Record<string, unknown>;
};

interface Fixture {
  readonly files?: Record<string, string>;
  readonly records?: Record<string, ArtifactRecord>;
  readonly comments?: readonly Comment[];
  readonly policy?: 'proceed' | 'request';
}

const recordOf = (
  input: Record<string, unknown>,
  revision: number,
): ArtifactRecord => ({
  artifactId: String(input.artifactId ?? 'checkout-7f3a'),
  kind: 'preview',
  title: String(input.title ?? 'Checkout'),
  revision,
  revisions: revision,
  targets: [],
  source: 'html',
  path: String(input.path ?? 'src/checkout.html'),
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
});

const harness = (fixture: Fixture = {}) => {
  const writes: Write[] = [];
  const files = fixture.files ?? { 'src/checkout.html': SOURCE };
  const services = servicesFor((id) => {
    switch (id) {
      case 'files/v1':
        return {
          content: async ({ path }: { readonly path: string }) =>
            files[path] === undefined
              ? { status: 'ready', value: { status: 'not_found' } }
              : {
                  status: 'ready',
                  value: {
                    status: 'read',
                    path,
                    content: files[path],
                    truncated: false,
                    binary: false,
                  },
                },
        };
      case 'artifacts/v1':
        return {
          read: async ({ artifactId }: { readonly artifactId: string }) =>
            fixture.records?.[artifactId],
          create: async (input: Record<string, unknown>) => {
            writes.push({ method: 'create', input });

            return recordOf(input, 1);
          },
          revise: async (input: Record<string, unknown>) => {
            writes.push({ method: 'revise', input });
            const previous = fixture.records?.[String(input.artifactId)];

            return recordOf(
              { ...previous, ...input },
              (previous?.revision ?? 1) + 1,
            );
          },
          policy: async () => ({ policy: fixture.policy ?? 'proceed' }),
        };
      case 'comments/v1':
        return { list: async () => fixture.comments ?? [] };
      default:
        throw new Error(`unexpected contract ${id}`);
    }
  });

  return {
    writes,
    execute: (input: Record<string, unknown>) =>
      tool.bind(services).execute(input as never, testCall),
    services,
  };
};

describe('papercraft_preview', () => {
  test('fails before anything is registered when the source cannot be read', async () => {
    const h = harness({ files: {} });

    await assert.rejects(
      h.execute({ title: 'Checkout', source: 'html', path: 'missing.html' }),
    );
    assert.deepEqual(h.writes, []);
  });

  test('a new preview anchors to its own source and hands over its bytes', async () => {
    const h = harness();
    const state = await h.execute({
      title: 'Checkout',
      source: 'html',
      path: 'src/checkout.html',
    });

    const create = h.writes[0];
    assert.equal(create?.method, 'create');
    assert.deepEqual(create?.input.targets, [{ path: 'src/checkout.html' }]);

    // The entries and the bytes come from one snapshot: the bytes hash to the
    // entry the event will name.
    const markup = deriveMarkup('html', 'src/checkout.html', SOURCE);
    assert.deepEqual(create?.input.entries, [
      { path: 'index.html', sha256: sha256(markup) },
    ]);
    const [file] = (create?.input.files ?? []) as {
      path: string;
      base64: string;
    }[];
    assert.equal(Buffer.from(file?.base64 ?? '', 'base64').toString(), markup);

    assert.equal(state.artifactId, 'checkout-7f3a');
    assert.equal(state.revision, 1);
    assert.deepEqual(state.comments, []);
    assert.deepEqual(state.review, { policy: 'proceed', pending: false });
  });

  test('a component preview hands over its module, its sheet and its markup', async () => {
    const h = harness({
      files: {
        'src/Pay.tsx':
          'export function Pay() { return <button className="p-2">Pagar</button>; }',
      },
    });
    const state = await h.execute({
      title: 'Pay',
      source: 'component',
      path: 'src/Pay.tsx',
      entry: 'Pay',
    });

    const create = h.writes[0];
    const entries = create?.input.entries as { path: string; sha256: string }[];
    const files = create?.input.files as { path: string; base64: string }[];

    assert.deepEqual(
      entries.map((entry) => entry.path),
      ['index.html', 'index.js', 'index.css'],
    );
    // Every entry travels with the bytes that hash to it.
    for (const entry of entries) {
      const file = files.find((candidate) => candidate.path === entry.path);
      assert.equal(
        sha256(Buffer.from(file?.base64 ?? '', 'base64').toString('utf8')),
        entry.sha256,
      );
    }
    assert.equal(create?.input.entry, 'Pay');
    assert.deepEqual(state.files, entries);
  });

  test('a component that does not compile fails before anything is registered', async () => {
    const h = harness({
      files: { 'src/Broken.tsx': 'export default () => <div>;' },
    });

    await assert.rejects(
      h.execute({
        title: 'Broken',
        source: 'component',
        path: 'src/Broken.tsx',
      }),
      /src\/Broken\.tsx/,
    );
    assert.deepEqual(h.writes, []);
  });

  test('explicit targets replace the default anchor', async () => {
    const h = harness();
    await h.execute({
      title: 'Checkout',
      source: 'html',
      path: 'src/checkout.html',
      targets: [{ path: 'src/Checkout.tsx', line: 42 }],
    });

    assert.deepEqual(h.writes[0]?.input.targets, [
      { path: 'src/Checkout.tsx', line: 42 },
    ]);
  });

  test('the answer carries the pending comments with their anchors', async () => {
    const anchor = { form: 'source', path: 'src/checkout.html', line: 1 };
    const h = harness({
      comments: [
        {
          commentId: 'c1',
          target: {
            kind: 'artifact',
            id: 'checkout-7f3a',
            revision: 1,
            anchor,
          },
          text: 'mais respiro',
          author: 'ada',
          resolved: false,
          createdAt: '',
        },
        {
          commentId: 'c2',
          target: {
            kind: 'artifact',
            id: 'checkout-7f3a',
            revision: 1,
            anchor,
          },
          text: 'já resolvido',
          resolved: true,
          createdAt: '',
        },
      ] as Comment[],
    });

    const state = await h.execute({
      title: 'Checkout',
      source: 'html',
      path: 'src/checkout.html',
    });

    assert.deepEqual(state.comments, [
      {
        commentId: 'c1',
        revision: 1,
        text: 'mais respiro',
        author: 'ada',
        anchor,
        replies: [],
      },
    ]);
  });

  test('the answer carries each unresolved root with its thread, never a reply alone', async () => {
    const anchor = {
      form: 'source' as const,
      path: 'src/checkout.html',
      line: 1,
    };
    const target = {
      kind: 'artifact',
      id: 'checkout-7f3a',
      revision: 1,
      anchor,
    };
    const comment = (
      commentId: string,
      text: string,
      extra: Partial<Comment> = {},
    ): Comment => ({
      commentId,
      target,
      text,
      resolved: false,
      createdAt: '',
      ...extra,
    });
    const h = harness({
      comments: [
        comment('root', 'mais respiro', { author: 'ada' }),
        comment('ask', 'quanto?', { author: 'agent', inReplyTo: 'root' }),
        comment('answer', '16px', { author: 'ada', inReplyTo: 'root' }),
        comment('done', 'pronto', { resolved: true }),
        comment('done-reply', 'feito', {
          author: 'agent',
          inReplyTo: 'done',
        }),
      ],
    });

    const state = await h.execute({
      title: 'Checkout',
      source: 'html',
      path: 'src/checkout.html',
    });

    assert.deepEqual(state.comments, [
      {
        commentId: 'root',
        revision: 1,
        text: 'mais respiro',
        author: 'ada',
        anchor,
        replies: [
          { commentId: 'ask', author: 'agent', text: 'quanto?' },
          { commentId: 'answer', author: 'ada', text: '16px' },
        ],
      },
    ]);
  });

  test('artifact_id publishes the next revision of that preview', async () => {
    const previous = recordOf(
      { artifactId: 'checkout-7f3a', path: 'src/checkout.html' },
      1,
    );
    const h = harness({ records: { 'checkout-7f3a': previous } });

    const state = await h.execute({
      artifact_id: 'checkout-7f3a',
      notes: 'mais respiro no botão',
    });

    assert.deepEqual(
      h.writes.map((write) => write.method),
      ['revise'],
    );
    const revise = h.writes[0]?.input ?? {};
    assert.equal(revise.artifactId, 'checkout-7f3a');
    assert.equal(revise.changeNote, 'mais respiro no botão');
    assert.equal(revise.path, 'src/checkout.html');
    assert.equal(state.revision, 2);
  });

  test('an unknown artifact_id is refused without a write', async () => {
    const h = harness();

    await assert.rejects(h.execute({ artifact_id: 'nope-0000' }));
    assert.deepEqual(h.writes, []);
  });

  test('a new preview without title, source or path is refused', async () => {
    const h = harness();

    await assert.rejects(
      h.execute({ source: 'html', path: 'src/checkout.html' }),
    );
    assert.deepEqual(h.writes, []);
  });

  test('under the request policy it answers at once that approval is pending', async () => {
    const h = harness({ policy: 'request' });
    const state = await h.execute({
      title: 'Checkout',
      source: 'html',
      path: 'src/checkout.html',
    });

    assert.deepEqual(state.review, { policy: 'request', pending: true });
  });
});

describe('the preview kind', () => {
  test('declares its body for the registry frame to mount', () => {
    const kind = previewKind(harness().services);

    assert.equal(kind.bodyTag, 'papercraft-preview');
    assert.equal(kind.blockType, 'papercraft.preview/v1');
    // The canvas draws its own header over the body.
    assert.equal(kind.header, 'body');
  });

  test('materialize derives the entries and bytes of a payload', async () => {
    const h = harness();
    const kind = previewKind(h.services);

    const result = await kind.materialize(
      {
        payload: { source: 'html', path: 'src/checkout.html' },
        artifactId: 'checkout-7f3a',
        revision: 1,
        title: 'Checkout',
      },
      testCall,
    );

    const markup = deriveMarkup('html', 'src/checkout.html', SOURCE);
    assert.deepEqual(result.entries, [
      { path: 'index.html', sha256: sha256(markup) },
    ]);
    assert.deepEqual(result.targets, [{ path: 'src/checkout.html' }]);
    assert.equal(
      Buffer.from(result.files?.[0]?.base64 ?? '', 'base64').toString(),
      markup,
    );
  });

  test('materialize refuses a payload outside its schema', async () => {
    const kind = previewKind(harness().services);

    await assert.rejects(
      Promise.resolve(
        kind.materialize(
          {
            payload: { source: 'site', path: 'x' },
            artifactId: 'a',
            revision: 1,
            title: 't',
          },
          testCall,
        ),
      ),
    );
  });
});
