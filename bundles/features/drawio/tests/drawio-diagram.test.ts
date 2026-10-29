// The `drawio_diagram` tool, at its public boundary: the model's input, the
// state it answers, and what it asks of the external boundaries — the files it
// reads and writes in the leased sandbox and the revisions it publishes to
// `artifacts/v1`.
//
// Contract matrix (spec "drawio_diagram" steps 1–9 and "Revisões e base",
// plan §5 T1–T20):
// - a create from a draft, by relative or absolute path, publishes revision 1
//   with one `diagram.drawio` entry holding the normalized XML;
// - every invalid combination, unknown or foreign artifact, path outside the
//   Project or in the registry's directory, unreadable draft, invalid text or
//   XML, reserved note, unchanged XML and base above the latest is refused
//   with `invalid_input`, publishing nothing;
// - base = latest publishes the next revision; base < latest lists the newer
//   revisions, the user's edits marked;
// - checkout writes the latest revision to a new file only;
// - no lease is `unavailable` with the lease state;
// - the answer lists the open comments, and a failed comments read is a
//   warning.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  type Comment,
  DIAGRAM_ENTRY,
  DIAGRAM_KIND,
  USER_CHANGE_NOTE,
} from '../src/contracts/index.js';
import { tool } from '../src/host/tools/drawio-diagram.js';
import { normalizeDiagram } from '../src/host/xml.js';
import {
  type SeedArtifact,
  sha256,
  textOf,
  type WorldOptions,
  world,
} from './support/fakes.js';
import { testCall } from './support/services.js';

/* Fixtures ------------------------------------------------------------------- */

const DRAFT = '/workspace/.doric/artifacts/drafts/a.drawio';

const model = (cells = ''): string =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;

const vertex = (id: string, value: string): string =>
  `<mxCell id="${id}" value="${value}" parent="1" vertex="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>`;

/** A valid draft: one page "p1" named "A" with the root cells and one vertex. */
const drawio = (value: string): string =>
  `<mxfile host="app.diagrams.net"><diagram id="p1" name="A">${model(vertex('a', value))}</diagram></mxfile>`;

const compressed = (value: string): string =>
  `<mxfile host="app.diagrams.net" compressed="true"><diagram id="p1" name="A">${deflateRawSync(
    Buffer.from(encodeURIComponent(model(vertex('a', value))), 'utf8'),
  ).toString('base64')}</diagram></mxfile>`;

const normalized = (text: string): string => {
  const result = normalizeDiagram(text);

  assert.ok('xml' in result, 'fixture: the draft is a valid diagram');

  return result.xml;
};

/** An existing diagram whose latest revision is `revisions.length`. */
const diagram = (
  revisions: SeedArtifact['revisions'],
  extra: Partial<SeedArtifact> = {},
): SeedArtifact => ({
  artifactId: 'fluxo-1',
  title: 'Fluxo',
  revisions,
  ...extra,
});

const harness = (options: WorldOptions = {}) => {
  const w = world(options);

  return {
    ...w,
    execute: (input: Record<string, unknown>) =>
      tool.bind(w.services).execute(input as never, testCall),
    /** Nothing was published: no create and no revise reached the registry. */
    assertNothingPublished: () => assert.deepEqual(w.artifacts.writes, []),
  };
};

/** A ContractError with the given code and, when given, the message. */
const rejection =
  (
    code: string,
    message?: string | RegExp,
    details?: Record<string, unknown>,
  ) =>
  (error: unknown): boolean => {
    const e = error as { code?: unknown; message?: unknown; details?: unknown };

    assert.equal(e.code, code, `code of: ${String(e.message)}`);

    if (typeof message === 'string') {
      assert.equal(e.message, message);
    } else if (message !== undefined) {
      assert.match(String(e.message), message);
    }

    if (details !== undefined) {
      assert.deepEqual(
        Object.fromEntries(
          Object.keys(details).map((key) => [
            key,
            (e.details as Record<string, unknown> | undefined)?.[key],
          ]),
        ),
        details,
      );
    }

    return true;
  };

/* Create ----------------------------------------------------------------------- */

describe('drawio_diagram: create', () => {
  for (const [label, path] of [
    ['T1: a relative path', '../.doric/artifacts/drafts/a.drawio'],
    ['T2: an absolute path', DRAFT],
  ] as const) {
    test(`${label} publishes revision 1 with the normalized XML as its one entry`, async () => {
      const draft = drawio('Início');
      const h = harness({ files: { [DRAFT]: draft } });

      const state = await h.execute({ title: 'Fluxo', path });

      const xml = normalized(draft);
      assert.equal(h.artifacts.writes.length, 1);
      const [create] = h.artifacts.writes;
      assert.equal(create?.method, 'create');
      assert.equal(create?.input.kind, DIAGRAM_KIND);
      assert.equal(create?.input.title, 'Fluxo');
      assert.equal(create?.input.path, DRAFT);
      assert.deepEqual(create?.input.entries, [
        { path: DIAGRAM_ENTRY, sha256: sha256(xml) },
      ]);
      assert.equal(create?.input.files.length, 1);
      assert.equal(create?.input.files[0]?.path, DIAGRAM_ENTRY);
      assert.equal(textOf(create?.input.files[0]?.base64 ?? ''), xml);
      assert.ok(!('targets' in (create?.input ?? {})), 'no targets');

      assert.equal(state.revision, 1);
      assert.equal(state.revisions, 1);
      assert.equal(state.title, 'Fluxo');
      assert.deepEqual(state.pages, [{ id: 'p1', name: 'A', cells: 3 }]);
      assert.deepEqual(state.comments, []);
      assert.equal(state.checkout, undefined);
    });
  }

  test('T15: a compressed draft is accepted and stored as uncompressed text', async () => {
    const h = harness({ files: { [DRAFT]: compressed('Início') } });

    await h.execute({ title: 'Fluxo', path: DRAFT });

    const stored = textOf(h.artifacts.writes[0]?.input.files[0]?.base64 ?? '');
    assert.ok(stored.includes('<mxGraphModel'));
    assert.ok(stored.includes('compressed="false"'));
  });
});

/* Refusals ------------------------------------------------------------------- */

describe('drawio_diagram: refusals publish nothing', () => {
  test('T3: each invalid combination is refused before anything is read', async () => {
    const cases: readonly [Record<string, unknown>, string | undefined][] = [
      [{ path: DRAFT }, undefined],
      [
        { title: 'Fluxo', path: DRAFT, base_revision: 1 },
        'checkout and base_revision need artifact_id.',
      ],
      [
        { title: 'Fluxo', path: DRAFT, checkout: true },
        'checkout and base_revision need artifact_id.',
      ],
      [
        {
          artifact_id: 'fluxo-1',
          checkout: true,
          base_revision: 1,
          path: DRAFT,
        },
        undefined,
      ],
      [
        { artifact_id: 'fluxo-1', checkout: true, title: 'Outro', path: DRAFT },
        undefined,
      ],
      [
        { artifact_id: 'fluxo-1', checkout: true, notes: 'x', path: DRAFT },
        undefined,
      ],
      [
        { artifact_id: 'fluxo-1', path: DRAFT },
        'Pass base_revision: the revision your draft holds.',
      ],
    ];

    for (const [input, message] of cases) {
      const h = harness({
        files: { [DRAFT]: drawio('x') },
        artifacts: [diagram([{ xml: drawio('x') }])],
      });

      await assert.rejects(
        h.execute(input),
        rejection('invalid_input', message),
      );
      assert.deepEqual(
        h.sandbox.reads,
        [],
        `no getFile for ${JSON.stringify(input)}`,
      );
      assert.deepEqual(
        h.artifacts.reads,
        [],
        `no read for ${JSON.stringify(input)}`,
      );
      assert.deepEqual(h.sandbox.writes, []);
      h.assertNothingPublished();
    }
  });

  test('T4: an unknown artifact_id, or one of another kind, is not a diagram', async () => {
    const h = harness({
      files: { [DRAFT]: drawio('x') },
      artifacts: [
        {
          artifactId: 'checkout-7f3a',
          kind: 'preview',
          revisions: [{ xml: '<p/>' }],
        },
      ],
    });

    await assert.rejects(
      h.execute({ artifact_id: 'nope-1', base_revision: 1, path: DRAFT }),
      rejection('invalid_input', /^There is no diagram /),
    );
    await assert.rejects(
      h.execute({
        artifact_id: 'checkout-7f3a',
        base_revision: 1,
        path: DRAFT,
      }),
      rejection('invalid_input', /is a "preview", not a diagram/),
    );
    h.assertNothingPublished();
  });

  test('T5: a path outside the Project is refused', async () => {
    for (const path of ['/etc/a.drawio', '../../a.drawio']) {
      const h = harness({
        files: { '/etc/a.drawio': drawio('x'), '/a.drawio': drawio('x') },
      });

      await assert.rejects(
        h.execute({ title: 'Fluxo', path }),
        rejection('invalid_input', 'The path is outside the Project.'),
      );
      h.assertNothingPublished();
    }
  });

  test('T6: a path inside the registry directory of the diagram is refused', async () => {
    const inside = '/workspace/.doric/artifacts/fluxo-1/diagram.drawio';
    const h = harness({
      files: { [inside]: drawio('y') },
      artifacts: [diagram([{ xml: drawio('x') }])],
    });

    await assert.rejects(
      h.execute({ artifact_id: 'fluxo-1', base_revision: 1, path: inside }),
      rejection(
        'invalid_input',
        "That is where the registry keeps this diagram's revisions; use checkout to get a copy.",
      ),
    );
    h.assertNothingPublished();
  });

  test('T7: a missing draft, or a directory, cannot be read', async () => {
    const missing = '/workspace/.doric/artifacts/drafts/missing.drawio';
    const folder = '/workspace/.doric/artifacts/drafts';
    const h = harness({ dirs: [folder] });

    for (const path of [missing, folder]) {
      await assert.rejects(
        h.execute({ title: 'Fluxo', path }),
        rejection('invalid_input', new RegExp(`^Cannot read ${path}: .+`)),
      );
    }
    h.assertNothingPublished();
  });

  test('T8: bytes that are not UTF-8 are refused', async () => {
    const h = harness({
      files: { [DRAFT]: new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]) },
    });

    await assert.rejects(
      h.execute({ title: 'Fluxo', path: DRAFT }),
      rejection('invalid_input'),
    );
    h.assertNothingPublished();
  });

  test('T9: invalid XML is refused with the reason normalizeDiagram gives', async () => {
    const bad = '<mxfile><diagram id="p1"></mxfile>';
    const h = harness({ files: { [DRAFT]: bad } });

    const reason = normalizeDiagram(bad);
    assert.ok('error' in reason, 'fixture: the draft is invalid');
    await assert.rejects(
      h.execute({ title: 'Fluxo', path: DRAFT }),
      rejection('invalid_input', reason.error),
    );
    h.assertNothingPublished();
  });

  test("T10: the user's change note is reserved, on create and on revise", async () => {
    const reserved = "That note is reserved for the user's own edits.";
    const h = harness({
      files: { [DRAFT]: drawio('novo') },
      artifacts: [diagram([{ xml: drawio('velho') }])],
    });

    await assert.rejects(
      h.execute({ title: 'Fluxo', path: DRAFT, notes: USER_CHANGE_NOTE }),
      rejection('invalid_input', reserved),
    );
    await assert.rejects(
      h.execute({
        artifact_id: 'fluxo-1',
        base_revision: 1,
        path: DRAFT,
        notes: USER_CHANGE_NOTE,
      }),
      rejection('invalid_input', reserved),
    );
    h.assertNothingPublished();
  });

  test('T11: a draft that normalizes to the latest revision did not change', async () => {
    // The latest revision holds the normalized text; the draft is the same
    // diagram with its page compressed.
    const h = harness({
      files: { [DRAFT]: compressed('igual') },
      artifacts: [
        diagram([{ xml: '<mxfile/>' }, { xml: normalized(drawio('igual')) }]),
      ],
    });

    await assert.rejects(
      h.execute({ artifact_id: 'fluxo-1', base_revision: 2, path: DRAFT }),
      rejection(
        'invalid_input',
        'The diagram did not change since revision 2.',
      ),
    );
    h.assertNothingPublished();
  });

  test('T12: a base_revision above the latest does not exist', async () => {
    const h = harness({
      files: { [DRAFT]: drawio('novo') },
      artifacts: [diagram([{ xml: drawio('velho') }])],
    });

    await assert.rejects(
      h.execute({ artifact_id: 'fluxo-1', base_revision: 2, path: DRAFT }),
      rejection('invalid_input', 'Revision 2 does not exist; the latest is 1.'),
    );
    h.assertNothingPublished();
  });

  test('T19: without a lease the call is unavailable, with the lease state', async () => {
    const h = harness({ files: { [DRAFT]: drawio('x') }, lease: 'pending' });

    await assert.rejects(
      h.execute({ title: 'Fluxo', path: DRAFT }),
      rejection('unavailable', undefined, { lease: 'pending' }),
    );
    h.assertNothingPublished();
  });
});

/* Revisions -------------------------------------------------------------------- */

describe('drawio_diagram: revisions', () => {
  test('T13: base_revision equal to the latest publishes the next revision, keeping the title', async () => {
    const draft = drawio('novo');
    const h = harness({
      files: { [DRAFT]: draft },
      artifacts: [diagram([{ xml: drawio('velho'), path: DRAFT }])],
    });

    const state = await h.execute({
      artifact_id: 'fluxo-1',
      base_revision: 1,
      path: DRAFT,
      notes: 'tweak',
    });

    const xml = normalized(draft);
    assert.deepEqual(h.artifacts.writes, [
      {
        method: 'revise',
        input: {
          artifactId: 'fluxo-1',
          path: DRAFT,
          changeNote: 'tweak',
          entries: [{ path: DIAGRAM_ENTRY, sha256: sha256(xml) }],
          files: [
            {
              path: DIAGRAM_ENTRY,
              base64: Buffer.from(xml, 'utf8').toString('base64'),
            },
          ],
        },
      },
    ]);
    assert.equal(state.artifactId, 'fluxo-1');
    assert.equal(state.revision, 2);
    assert.equal(state.revisions, 2);
    assert.equal(state.title, 'Fluxo');
    assert.deepEqual(state.pages, [{ id: 'p1', name: 'A', cells: 3 }]);
  });

  test("T14: a base_revision below the latest lists the newer revisions, the user's edits marked", async () => {
    const h = harness({
      files: { [DRAFT]: drawio('meu') },
      artifacts: [
        diagram([
          { xml: drawio('1') },
          { xml: drawio('2') },
          { xml: drawio('3'), changeNote: 'base' },
          { xml: drawio('4'), changeNote: USER_CHANGE_NOTE },
          { xml: drawio('5'), changeNote: 'tweak' },
        ]),
      ],
    });

    await assert.rejects(
      h.execute({ artifact_id: 'fluxo-1', base_revision: 3, path: DRAFT }),
      rejection(
        'invalid_input',
        'Revision 5 is newer than your base_revision 3. Newer revisions: 4 (the user\'s edit in the editor), 5 ("tweak"). Check out revision 5 to a new path, reapply the changes you still want there, and call again with base_revision 5.',
      ),
    );
    await assert.rejects(
      h.execute({ artifact_id: 'fluxo-1', base_revision: 1, path: DRAFT }),
      rejection(
        'invalid_input',
        /Newer revisions: 2 \(no note\), 3 \("base"\), 4 /,
      ),
    );
    h.assertNothingPublished();
  });
});

/* Checkout ------------------------------------------------------------------- */

describe('drawio_diagram: checkout', () => {
  const latest = drawio('última');
  const seeded = () => diagram([{ xml: drawio('primeira') }, { xml: latest }]);

  test('T16: checkout writes the latest revision to a new file and publishes nothing', async () => {
    const target = '/workspace/.doric/artifacts/drafts/new/fluxo.drawio';
    const h = harness({ artifacts: [seeded()] });

    const state = await h.execute({
      artifact_id: 'fluxo-1',
      checkout: true,
      path: target,
    });

    assert.deepEqual(h.sandbox.writes, [{ path: target, content: latest }]);
    assert.equal(state.checkout, target);
    assert.equal(state.artifactId, 'fluxo-1');
    assert.equal(state.revision, 2);
    assert.equal(state.revisions, 2);
    assert.equal(state.title, 'Fluxo');
    assert.deepEqual(state.pages, [{ id: 'p1', name: 'A', cells: 3 }]);
    h.assertNothingPublished();
  });

  test('T17: checkout refuses an existing path, a file or a directory, and leaves it as it was', async () => {
    const file = '/workspace/.doric/artifacts/drafts/a.drawio';
    const folder = '/workspace/.doric/artifacts/drafts/sub';
    const h = harness({
      files: { [file]: 'mine' },
      dirs: [folder],
      artifacts: [seeded()],
    });

    for (const path of [file, folder]) {
      await assert.rejects(
        h.execute({ artifact_id: 'fluxo-1', checkout: true, path }),
        rejection(
          'invalid_input',
          `${path} exists; checkout writes only a new file.`,
        ),
      );
    }
    assert.deepEqual(h.sandbox.writes, []);
    assert.equal(
      Buffer.from(h.sandbox.files.get(file) ?? []).toString('utf8'),
      'mine',
    );
    h.assertNothingPublished();
  });

  test('T18: checkout without the stored bytes of the latest revision is unavailable', async () => {
    const h = harness({
      artifacts: [
        diagram([{ xml: drawio('primeira') }, { xml: latest, gone: true }]),
      ],
    });

    await assert.rejects(
      h.execute({
        artifact_id: 'fluxo-1',
        checkout: true,
        path: '/workspace/.doric/artifacts/drafts/new.drawio',
      }),
      rejection('unavailable', 'The stored bytes of revision 2 are gone.'),
    );
    assert.deepEqual(h.sandbox.writes, []);
    h.assertNothingPublished();
  });
});

/* Comments ------------------------------------------------------------------- */

describe('drawio_diagram: comments', () => {
  const anchor = { form: 'point', x: 10, y: 20 } as const;
  const comment = (
    fields: Partial<Comment> & { commentId: string },
  ): Comment => ({
    target: { kind: 'artifact', id: 'diagram-0001', revision: 1, anchor },
    text: fields.commentId,
    author: 'ana',
    resolved: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...fields,
  });

  test('T20: the answer lists the open roots with their replies; a failed read is a warning', async () => {
    const comments = [
      comment({ commentId: 'c1' }),
      comment({ commentId: 'c2', resolved: true }),
      comment({ commentId: 'r1', inReplyTo: 'c1', author: 'agent' }),
      comment({ commentId: 'r2', inReplyTo: 'c2' }),
      comment({ commentId: 'c3' }),
    ];
    const h = harness({ files: { [DRAFT]: drawio('x') }, comments });

    const state = await h.execute({ title: 'Fluxo', path: DRAFT });

    assert.deepEqual(state.comments, [
      {
        commentId: 'c1',
        revision: 1,
        text: 'c1',
        author: 'ana',
        anchor,
        replies: [{ commentId: 'r1', author: 'agent', text: 'r1' }],
      },
      {
        commentId: 'c3',
        revision: 1,
        text: 'c3',
        author: 'ana',
        anchor,
        replies: [],
      },
    ]);

    const failing = harness({
      files: { [DRAFT]: drawio('x') },
      commentsFail: true,
    });
    const degraded = await failing.execute({ title: 'Fluxo', path: DRAFT });

    assert.equal(degraded.revision, 1);
    assert.deepEqual(degraded.comments, []);
    assert.equal(degraded.warnings?.length, 1);
    assert.equal(failing.artifacts.writes.length, 1);
  });
});
