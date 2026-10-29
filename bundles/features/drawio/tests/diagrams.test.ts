// `drawio.diagrams/v1.read`, at the service a window reaches over the bridge:
// the stored XML of one revision, `missing` when any part of it is absent,
// and `unleased` with the lease state when the Project has no lease.
//
// Contract matrix (spec "Serviço drawio.diagrams/v1", plan §5 D1–D4):
// - a revision with bytes answers ok with its XML and the revision count;
// - no record, no revision, no `diagram.drawio` entry or no bytes: missing;
// - each lease state without a lease: unleased;
// - the method is exposed to the desktop and its answer is a closed union.

//
// `drawio.diagrams/v1.save` (spec "Serviço drawio.diagrams/v1", plan §6 S1–S8):
// - valid XML writes the next revision, noted USER_CHANGE_NOTE, without a path,
//   even over a newer revision; normalized XML equal to the latest writes nothing;
// - XML normalizeDiagram refuses is invalid_input before the lease is asked;
// - no lease is unavailable with the lease state; no artifact is not_found and
//   a non-diagram is invalid_input; none of these writes;
// - after the user's save, the tool's call on the agent's old base is refused.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import type { Services } from 'bundle/contracts';

import {
  type DiagramExportInput,
  type DiagramRead,
  type DiagramSaved,
  DrawioDiagramsV1,
  diagramExportInputSchema,
  diagramReadSchema,
  diagramSavedSchema,
  diagramSaveInputSchema,
  drawioDiagramsMethods,
  type ExportResult,
  exportResultSchema,
  MAX_DIAGRAM_BYTES,
  MAX_SVG_BYTES,
  USER_CHANGE_NOTE,
} from '../src/contracts/index.js';
import {
  drawioDiagramsService,
  exportPathError,
  exportSvgError,
} from '../src/host/diagrams.js';
import { tool } from '../src/host/tools/drawio-diagram.js';
import { normalizeDiagram } from '../src/host/xml.js';
import {
  base64Of,
  type LeaseStatus,
  type SeedArtifact,
  sha256,
  textOf,
  type WorldOptions,
  world,
} from './support/fakes.js';
import { testCall } from './support/services.js';

const FIRST = '<mxfile compressed="false"><diagram id="p1" name="A"/></mxfile>';
const SECOND =
  '<mxfile compressed="false"><diagram id="p1" name="Á"/></mxfile>';

const seed: readonly SeedArtifact[] = [
  { artifactId: 'fluxo-1', revisions: [{ xml: FIRST }, { xml: SECOND }] },
  { artifactId: 'sem-bytes', revisions: [{ xml: FIRST, gone: true }] },
  { artifactId: 'sem-entrada', revisions: [{}] },
];

const read = (
  input: { artifactId: string; revision: number },
  lease: LeaseStatus = 'ready',
): Promise<DiagramRead> => {
  const { services } = world({ artifacts: seed, lease });

  return drawioDiagramsService.methods.read.execute(input, testCall, services);
};

describe('drawio.diagrams/v1.read', () => {
  test('provides drawio.diagrams/v1', () => {
    assert.equal(drawioDiagramsService.id, DrawioDiagramsV1.id);
  });

  test('D1: a revision with its bytes answers its XML and the revision count', async () => {
    assert.deepEqual(await read({ artifactId: 'fluxo-1', revision: 1 }), {
      status: 'ok',
      xml: FIRST,
      revision: 1,
      revisions: 2,
    });
    assert.deepEqual(await read({ artifactId: 'fluxo-1', revision: 2 }), {
      status: 'ok',
      xml: SECOND,
      revision: 2,
      revisions: 2,
    });
  });

  test('D2: no record, no revision, no bytes or no diagram.drawio entry is missing', async () => {
    for (const input of [
      { artifactId: 'nope-1', revision: 1 },
      { artifactId: 'fluxo-1', revision: 3 },
      { artifactId: 'sem-bytes', revision: 1 },
      { artifactId: 'sem-entrada', revision: 1 },
    ]) {
      assert.deepEqual(
        await read(input),
        { status: 'missing' },
        JSON.stringify(input),
      );
    }
  });

  test('D3: without a lease it answers unleased with the lease state', async () => {
    for (const lease of [
      'pending',
      'unavailable',
      'expired',
      'missing',
    ] as const) {
      assert.deepEqual(
        await read({ artifactId: 'fluxo-1', revision: 1 }, lease),
        {
          status: 'unleased',
          lease,
        },
      );
    }
  });

  test('D4: read is exposed to the desktop, and its answer is a closed union', () => {
    assert.equal(drawioDiagramsMethods.read.expose, 'desktop');

    for (const answer of [
      { status: 'ok', xml: FIRST, revision: 1, revisions: 2 },
      { status: 'missing' },
      { status: 'unleased', lease: 'pending' },
    ]) {
      assert.ok(
        diagramReadSchema.safeParse(answer).success,
        JSON.stringify(answer),
      );
    }
    assert.equal(
      diagramReadSchema.safeParse({ status: 'missing', extra: 1 }).success,
      false,
    );
    assert.equal(
      diagramReadSchema.safeParse({
        status: 'ok',
        xml: FIRST,
        revision: 1,
        revisions: 2,
        path: 'x',
      }).success,
      false,
    );
  });
});

/* save ------------------------------------------------------------------------ */

const model = (cells = ''): string =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;

const vertex = (id: string, value: string): string =>
  `<mxCell id="${id}" value="${value}" parent="1" vertex="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>`;

/** A valid diagram: one page "p1" named "A" with the root cells and one vertex. */
const drawio = (value: string): string =>
  `<mxfile host="app.diagrams.net"><diagram id="p1" name="A">${model(vertex('a', value))}</diagram></mxfile>`;

const compressed = (value: string): string =>
  `<mxfile host="app.diagrams.net" compressed="true"><diagram id="p1" name="A">${deflateRawSync(
    Buffer.from(encodeURIComponent(model(vertex('a', value))), 'utf8'),
  ).toString('base64')}</diagram></mxfile>`;

const normalized = (text: string): string => {
  const result = normalizeDiagram(text);

  assert.ok('xml' in result, 'fixture: a valid diagram');

  return result.xml;
};

const refusalOf = (text: string): string => {
  const result = normalizeDiagram(text);

  assert.ok('error' in result, 'fixture: an invalid diagram');

  return result.error;
};

/** Revisions 1–3 as the registry stores them: normalized XML. */
const REV: readonly [string, string, string] = [
  normalized(drawio('1')),
  normalized(drawio('2')),
  normalized(drawio('3')),
];

const threeRevisions = (extra: Partial<SeedArtifact> = {}): SeedArtifact => ({
  artifactId: 'fluxo-1',
  title: 'Fluxo',
  revisions: [
    { xml: REV[0] },
    { xml: REV[1], changeNote: 'agente' },
    { xml: REV[2], changeNote: 'base' },
  ],
  ...extra,
});

/** A world whose lease counts the `withLease` calls it receives. */
const saving = (options: WorldOptions = {}) => {
  const w = world({ artifacts: [threeRevisions()], ...options });
  let leaseCalls = 0;
  const services = {
    ...w.services,
    use: (contract: unknown, scope?: unknown) => {
      const api = (w.services.use as (c: unknown, s?: unknown) => unknown)(
        contract,
        scope,
      );

      if ((contract as { id?: string }).id !== 'runtime.lease/v1') {
        return api;
      }

      const lease = api as { withLease: (...args: unknown[]) => unknown };

      return {
        ...lease,
        withLease: (...args: unknown[]) => {
          leaseCalls += 1;

          return lease.withLease(...args);
        },
      };
    },
  } as unknown as Services;

  return {
    ...w,
    services,
    leaseCalls: () => leaseCalls,
    save: async (input: {
      artifactId: string;
      xml: string;
    }): Promise<DiagramSaved> =>
      drawioDiagramsService.methods.save.execute(input, testCall, services),
    /** Nothing was written: no create and no revise reached the registry. */
    assertNothingWritten: () => assert.deepEqual(w.artifacts.writes, []),
  };
};

/** A ContractError with the given code and, when given, the message and details. */
const rejection =
  (code: string, message?: string, details?: Record<string, unknown>) =>
  (error: unknown): boolean => {
    const e = error as { code?: unknown; message?: unknown; details?: unknown };

    assert.equal(e.code, code, `code of: ${String(e.message)}`);

    if (message !== undefined) {
      assert.equal(e.message, message);
    }

    if (details !== undefined) {
      assert.deepEqual(e.details, details);
    }

    return true;
  };

describe('drawio.diagrams/v1.save', () => {
  test("S1: valid XML writes revision 4, noted as the user's edit and without a path", async () => {
    const h = saving();
    const xml = drawio('novo');
    const stored = normalized(xml);
    const hash = sha256(stored);

    assert.deepEqual(await h.save({ artifactId: 'fluxo-1', xml }), {
      revision: 4,
      revisions: 4,
      sha256: hash,
    });
    assert.equal(h.artifacts.writes.length, 1);

    const [write] = h.artifacts.writes;

    assert.equal(write?.method, 'revise');
    assert.equal(write?.input.artifactId, 'fluxo-1');
    assert.equal(write?.input.changeNote, USER_CHANGE_NOTE);
    assert.equal('path' in (write?.input ?? {}), false, 'no path');
    assert.deepEqual(write?.input.entries, [
      { path: 'diagram.drawio', sha256: hash },
    ]);
    assert.deepEqual(write?.input.files, [
      { path: 'diagram.drawio', base64: base64Of(stored) },
    ]);
  });

  test('S2: XML that normalizes to the latest revision writes nothing and answers the latest', async () => {
    // Whitespace around the frame and inside the tags; normalizeDiagram keeps
    // the text nodes inside an mxGraphModel as they are.
    const spaced = `\n${REV[2]
      .replace('<diagram ', '\n  <diagram  ')
      .replace('<mxGraphModel>', '\n    <mxGraphModel >')
      .replace('</diagram>', '\n  </diagram >')
      .replace('<mxCell id="0"/>', '<mxCell  id="0" />')}\n`;

    assert.notEqual(spaced, REV[2], 'fixture: different whitespace');
    assert.equal(normalized(spaced), REV[2], 'fixture: same normalized XML');

    for (const xml of [REV[2], spaced, drawio('3')]) {
      const h = saving();

      assert.deepEqual(await h.save({ artifactId: 'fluxo-1', xml }), {
        revision: 3,
        revisions: 3,
        sha256: sha256(REV[2]),
      });
      h.assertNothingWritten();
    }
  });

  test('S3: XML equal to an older revision, not the latest, is written as revision 4', async () => {
    const h = saving();

    assert.deepEqual(await h.save({ artifactId: 'fluxo-1', xml: REV[1] }), {
      revision: 4,
      revisions: 4,
      sha256: sha256(REV[1]),
    });
    assert.equal(h.artifacts.writes.length, 1);
    assert.equal(h.artifacts.writes[0]?.method, 'revise');
  });

  test('S4: XML normalizeDiagram refuses is invalid_input, before the lease, writing nothing', async () => {
    for (const xml of [
      '<html><body/></html>',
      drawio('a'.repeat(MAX_DIAGRAM_BYTES + 16)),
    ]) {
      const h = saving();

      await assert.rejects(
        h.save({ artifactId: 'fluxo-1', xml }),
        rejection('invalid_input', refusalOf(xml)),
      );
      h.assertNothingWritten();
      assert.equal(h.leaseCalls(), 0, 'the lease is not consulted');
    }
  });

  test('S4: compressed XML is accepted and stored as uncompressed text', async () => {
    const h = saving();
    const xml = compressed('z');
    const stored = normalized(xml);

    assert.match(stored, /compressed="false"/, 'fixture: stored as text');
    assert.deepEqual(await h.save({ artifactId: 'fluxo-1', xml }), {
      revision: 4,
      revisions: 4,
      sha256: sha256(stored),
    });
    assert.equal(
      textOf(String(h.artifacts.writes[0]?.input.files[0]?.base64)),
      stored,
    );
  });

  test('S5: without a lease it is unavailable with the lease state, writing nothing', async () => {
    for (const lease of [
      'pending',
      'unavailable',
      'expired',
      'missing',
    ] as const satisfies readonly LeaseStatus[]) {
      const h = saving({ lease });

      await assert.rejects(
        h.save({ artifactId: 'fluxo-1', xml: drawio('novo') }),
        rejection('unavailable', undefined, { lease }),
      );
      h.assertNothingWritten();
    }
  });

  test('S6: an unknown artifact is not_found and a non-diagram is invalid_input; neither writes', async () => {
    const unknown = saving();

    await assert.rejects(
      unknown.save({ artifactId: 'nope-1', xml: drawio('novo') }),
      rejection('not_found'),
    );
    unknown.assertNothingWritten();

    const foreign = saving({
      artifacts: [threeRevisions({ artifactId: 'nota-1', kind: 'document' })],
    });

    await assert.rejects(
      foreign.save({ artifactId: 'nota-1', xml: drawio('novo') }),
      rejection(
        'invalid_input',
        'The artifact "nota-1" is a "document", not a diagram.',
      ),
    );
    foreign.assertNothingWritten();
  });

  test('S7: save is exposed to the desktop, and its input and output are closed', () => {
    assert.equal(drawioDiagramsMethods.save.expose, 'desktop');

    const sha = sha256('x');

    assert.ok(
      diagramSaveInputSchema.safeParse({ artifactId: 'fluxo-1', xml: '<a/>' })
        .success,
    );
    assert.equal(
      diagramSaveInputSchema.safeParse({
        artifactId: 'fluxo-1',
        xml: '<a/>',
        path: 'x',
      }).success,
      false,
    );
    assert.equal(
      diagramSaveInputSchema.safeParse({
        artifactId: 'Not An Id!',
        xml: '<a/>',
      }).success,
      false,
    );
    assert.ok(
      diagramSavedSchema.safeParse({ revision: 4, revisions: 4, sha256: sha })
        .success,
    );
    assert.equal(
      diagramSavedSchema.safeParse({
        revision: 4,
        revisions: 4,
        sha256: sha,
        extra: 1,
      }).success,
      false,
    );
    for (const bad of ['abc', sha.toUpperCase(), `${sha}0`]) {
      assert.equal(
        diagramSavedSchema.safeParse({ revision: 4, revisions: 4, sha256: bad })
          .success,
        false,
        bad,
      );
    }
  });

  test("S8: after the user's save, the tool refuses the agent's old base, listing the user's edit", async () => {
    const draft = '/workspace/.doric/artifacts/drafts/a.drawio';
    const h = saving({ files: { [draft]: drawio('agente') } });

    assert.equal(
      (await h.save({ artifactId: 'fluxo-1', xml: drawio('usuário') }))
        .revision,
      4,
    );
    assert.equal(h.artifacts.writes.length, 1);

    await assert.rejects(
      tool
        .bind(h.services)
        .execute(
          { artifact_id: 'fluxo-1', base_revision: 3, path: draft } as never,
          testCall,
        ),
      rejection(
        'invalid_input',
        "Revision 4 is newer than your base_revision 3. Newer revisions: 4 (the user's edit in the editor). Check out revision 4 to a new path, reapply the changes you still want there, and call again with base_revision 4.",
      ),
    );
    assert.equal(h.artifacts.writes.length, 1, 'the tool published nothing');
  });
});

/* export ---------------------------------------------------------------------- */

// `drawio.diagrams/v1.export` (spec "Serviço drawio.diagrams/v1", "Conferência
// antes de gravar"; plan §6 E1–E14):
// - writes `<path>.drawio` (the revision's stored XML, every page) and then
//   `<path>.drawio.svg` (the given svg), creating missing folders;
// - checks folders and files with `test` through `exec`, never `getFile`;
// - a folder, link or special entry at either file is `blocked`, also with
//   overwrite; a non-folder prefix is `blocked` with `not-a-folder`;
// - a regular file with overwrite false is `exists`; with overwrite true it is
//   replaced;
// - a failed check or write is `internal`; a failed second write removes the
//   first;
// - refused paths and SVGs are `invalid_input` before the lease.

/** Revision 2 of `fluxo-1`: two pages, as the registry stores it. */
const TWO_PAGES = normalized(
  `<mxfile host="app.diagrams.net"><diagram id="p1" name="A">${model(vertex('a', '1'))}</diagram><diagram id="p2" name="B">${model(vertex('b', '2'))}</diagram></mxfile>`,
);

/** An `xmlsvg` export of page 1: SVG text whose `<svg>` has a `content` attribute. */
const EXPORT_SVG = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" content="&lt;mxfile&gt;&lt;/mxfile&gt;"><g/></svg>`;

const REL_DRAWIO = 'docs/diagrams/fluxo.drawio';
const REL_SVG = 'docs/diagrams/fluxo.drawio.svg';
const ABS_DRAWIO = `/workspace/${REL_DRAWIO}`;
const ABS_SVG = `/workspace/${REL_SVG}`;
const FOLDERS = ['/workspace/docs', '/workspace/docs/diagrams'] as const;

const exportSeed: SeedArtifact = {
  artifactId: 'fluxo-1',
  revisions: [{ xml: REV[0] }, { xml: TWO_PAGES }],
};

/** A world seeded with `fluxo-1` that exports `docs/diagrams/fluxo` of revision 2 by default. */
const exporting = (options: WorldOptions = {}) => {
  const h = saving({ artifacts: [exportSeed], ...options });

  return {
    ...h,
    export: async (
      input: Partial<DiagramExportInput> = {},
    ): Promise<ExportResult> =>
      drawioDiagramsService.methods.export.execute(
        {
          artifactId: 'fluxo-1',
          revision: 2,
          path: 'docs/diagrams/fluxo',
          svg: EXPORT_SVG,
          overwrite: false,
          ...input,
        },
        testCall,
        h.services,
      ),
    /** The text of the file at `path` in the sandbox; undefined when no file. */
    contentOf: (path: string): string | undefined => {
      const bytes = h.sandbox.files.get(path);

      return bytes === undefined
        ? undefined
        : Buffer.from(bytes).toString('utf8');
    },
    /** No `writeFile` reached the sandbox. */
    assertNothingWritten: () => assert.deepEqual(h.sandbox.writes, []),
    /** C10: `getFile` was never used. */
    assertNoReads: () => assert.deepEqual(h.sandbox.reads, []),
  };
};

describe('drawio.diagrams/v1.export', () => {
  test('E1: writes the stored XML of every page and the given SVG, creating the missing folders', async () => {
    const h = exporting();

    assert.deepEqual(await h.export(), {
      status: 'written',
      files: [REL_DRAWIO, REL_SVG],
    });
    assert.deepEqual(
      h.sandbox.writes.map((write) => write.path),
      [ABS_DRAWIO, ABS_SVG],
      '.drawio first, then .drawio.svg',
    );
    assert.equal(h.contentOf(ABS_DRAWIO), TWO_PAGES);
    assert.equal(h.contentOf(ABS_SVG), EXPORT_SVG);
    for (const folder of FOLDERS) {
      assert.ok(h.sandbox.isDir(folder), folder);
    }
    h.assertNoReads();
  });

  test('E2: a path at the Project root writes both files and runs no folder check', async () => {
    const h = exporting();

    assert.deepEqual(await h.export({ path: 'fluxo' }), {
      status: 'written',
      files: ['fluxo.drawio', 'fluxo.drawio.svg'],
    });
    assert.ok(h.sandbox.execs.length > 0, 'the files are checked');
    for (const cmd of h.sandbox.execs) {
      assert.ok(
        cmd[2] === '/workspace/fluxo.drawio' ||
          cmd[2] === '/workspace/fluxo.drawio.svg',
        `only the files are checked: ${JSON.stringify(cmd)}`,
      );
    }
    assert.equal(h.contentOf('/workspace/fluxo.drawio'), TWO_PAGES);
    assert.equal(h.contentOf('/workspace/fluxo.drawio.svg'), EXPORT_SVG);
    h.assertNoReads();
  });

  test('E3: regular files with overwrite false are exists, in order, and nothing is written', async () => {
    for (const [files, expected] of [
      [{ [ABS_SVG]: 'old svg' }, [REL_SVG]],
      [
        { [ABS_DRAWIO]: 'old xml', [ABS_SVG]: 'old svg' },
        [REL_DRAWIO, REL_SVG],
      ],
    ] as const) {
      const h = exporting({ files, dirs: FOLDERS });

      assert.deepEqual(
        await h.export(),
        { status: 'exists', files: expected },
        JSON.stringify(files),
      );
      h.assertNothingWritten();
      for (const [path, content] of Object.entries(files)) {
        assert.equal(h.contentOf(path), content, `${path} is kept`);
      }
      h.assertNoReads();
    }
  });

  test('E4: regular files with overwrite true are replaced', async () => {
    for (const files of [
      { [ABS_SVG]: 'old svg' },
      { [ABS_DRAWIO]: 'old xml', [ABS_SVG]: 'old svg' },
    ] as Record<string, string>[]) {
      const h = exporting({ files, dirs: FOLDERS });

      assert.deepEqual(
        await h.export({ overwrite: true }),
        { status: 'written', files: [REL_DRAWIO, REL_SVG] },
        JSON.stringify(files),
      );
      assert.equal(h.contentOf(ABS_DRAWIO), TWO_PAGES);
      assert.equal(h.contentOf(ABS_SVG), EXPORT_SVG);
      h.assertNoReads();
    }
  });

  test('E5: a folder at either file is blocked as directory, also with overwrite, and keeps its contents', async () => {
    const cases = [
      { label: 'empty .drawio folder', at: ABS_DRAWIO, rel: REL_DRAWIO },
      {
        label: '.drawio folder with a child',
        at: ABS_DRAWIO,
        rel: REL_DRAWIO,
        child: `${ABS_DRAWIO}/inner.txt`,
      },
      {
        label: '.drawio.svg folder with a child',
        at: ABS_SVG,
        rel: REL_SVG,
        child: `${ABS_SVG}/inner.txt`,
      },
    ];

    for (const { label, at, rel, child } of cases) {
      for (const overwrite of [false, true]) {
        const h = exporting({
          dirs: [...FOLDERS, at],
          files: child === undefined ? {} : { [child]: 'keep me' },
        });

        assert.deepEqual(
          await h.export({ overwrite }),
          { status: 'blocked', path: rel, reason: 'directory' },
          `${label}, overwrite ${overwrite}`,
        );
        h.assertNothingWritten();
        assert.ok(h.sandbox.isDir(at), `${label}: the folder remains`);
        if (child !== undefined) {
          assert.equal(
            h.contentOf(child),
            'keep me',
            `${label}: the child remains`,
          );
        }
        h.assertNoReads();
      }
    }
  });

  test('E6: a link to a file, a broken link or a fifo at either file is blocked as special, also with overwrite', async () => {
    const target = '/workspace/other.txt';

    for (const [at, rel] of [
      [ABS_DRAWIO, REL_DRAWIO],
      [ABS_SVG, REL_SVG],
    ] as const) {
      const cases: { label: string; options: WorldOptions }[] = [
        {
          label: 'link to a file',
          options: { files: { [target]: 'other' }, links: { [at]: target } },
        },
        {
          label: 'broken link',
          options: { links: { [at]: '/workspace/nowhere' } },
        },
        { label: 'fifo', options: { specials: [at] } },
      ];

      for (const { label, options } of cases) {
        for (const overwrite of [false, true]) {
          const h = exporting({ dirs: FOLDERS, ...options });

          assert.deepEqual(
            await h.export({ overwrite }),
            { status: 'blocked', path: rel, reason: 'special' },
            `${label} at ${rel}, overwrite ${overwrite}`,
          );
          h.assertNothingWritten();
          assert.ok(h.sandbox.exists(at), `${label}: the entry remains`);
          h.assertNoReads();
        }
      }
    }
  });

  test('E7: a regular .drawio and a folder at .drawio.svg is blocked, not exists', async () => {
    const h = exporting({
      files: { [ABS_DRAWIO]: 'old xml' },
      dirs: [...FOLDERS, ABS_SVG],
    });

    assert.deepEqual(await h.export(), {
      status: 'blocked',
      path: REL_SVG,
      reason: 'directory',
    });
    h.assertNothingWritten();
    assert.equal(h.contentOf(ABS_DRAWIO), 'old xml');
    h.assertNoReads();
  });

  test('E8: a folder prefix that is a file or a broken link is blocked as not-a-folder with that prefix', async () => {
    const cases: { label: string; options: WorldOptions; path: string }[] = [
      {
        label: 'docs is a file',
        options: { files: { '/workspace/docs': 'x' } },
        path: 'docs',
      },
      {
        label: 'docs/diagrams is a file',
        options: {
          dirs: ['/workspace/docs'],
          files: { '/workspace/docs/diagrams': 'x' },
        },
        path: 'docs/diagrams',
      },
      {
        label: 'docs is a broken link',
        options: { links: { '/workspace/docs': '/workspace/nowhere' } },
        path: 'docs',
      },
    ];

    for (const { label, options, path } of cases) {
      for (const overwrite of [false, true]) {
        const h = exporting(options);

        assert.deepEqual(
          await h.export({ overwrite }),
          { status: 'blocked', path, reason: 'not-a-folder' },
          `${label}, overwrite ${overwrite}`,
        );
        h.assertNothingWritten();
        h.assertNoReads();
      }
    }
  });

  test('E8b: a folder prefix that is a link to a folder counts as a folder', async () => {
    const h = exporting({
      dirs: ['/workspace/real'],
      links: { '/workspace/docs': '/workspace/real' },
    });

    assert.deepEqual(await h.export(), {
      status: 'written',
      files: [REL_DRAWIO, REL_SVG],
    });
    h.assertNoReads();
  });

  test('E9: a check that exits 2, exits without a code or rejects is internal, and nothing is written', async () => {
    const checks = [
      {
        cmd: ['test', '-d', '/workspace/docs/diagrams'],
        rel: 'docs/diagrams',
        op: '-d',
      },
      { cmd: ['test', '-f', ABS_SVG], rel: REL_SVG, op: '-f' },
    ];

    for (const { cmd, rel, op } of checks) {
      for (const [answer, reason] of [
        [{ exitCode: 2 }, `test ${op} exited with 2`],
        [{ exitCode: null }, `test ${op} exited without a code`],
        [new Error('exec down'), 'exec down'],
      ] as const) {
        const h = exporting({
          dirs: FOLDERS,
          exec: (asked) =>
            JSON.stringify(asked) === JSON.stringify(cmd) ? answer : undefined,
        });

        await assert.rejects(
          h.export(),
          rejection('internal', `Could not check ${rel}: ${reason}`),
          `${JSON.stringify(cmd)} → ${reason}`,
        );
        assert.ok(
          h.sandbox.execs.some(
            (asked) => JSON.stringify(asked) === JSON.stringify(cmd),
          ),
          `fixture: ${JSON.stringify(cmd)} was run`,
        );
        h.assertNothingWritten();
        h.assertNoReads();
      }
    }
  });

  test('E10: a refused path or SVG is invalid_input before the lease, and nothing is written', async () => {
    const tooBig = `<svg content="x">${'a'.repeat(MAX_SVG_BYTES)}</svg>`;
    const refused: Partial<DiagramExportInput>[] = [
      ...[
        '../x',
        'a/../b',
        '/abs',
        '.doric/x',
        '.doric',
        'a//b',
        '',
        'a'.repeat(513),
        'a/./b',
        'x.drawio',
        'docs/x.drawio.svg',
      ].map((path) => ({ path })),
      ...[
        '<html><body/></html>',
        '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
        tooBig,
      ].map((svg) => ({ svg })),
    ];

    for (const input of refused) {
      const h = exporting({ dirs: FOLDERS });

      await assert.rejects(
        h.export(input),
        rejection('invalid_input'),
        JSON.stringify(input).slice(0, 80),
      );
      assert.equal(h.leaseCalls(), 0, 'the lease is not consulted');
      assert.deepEqual(h.sandbox.execs, [], 'nothing is checked');
      h.assertNothingWritten();
      h.assertNoReads();
    }
  });

  test('E10: exportPathError and exportSvgError refuse those inputs and accept good ones', () => {
    for (const path of [
      '../x',
      'a/../b',
      '/abs',
      '.doric/x',
      '.doric',
      'a//b',
      '',
      'a'.repeat(513),
      'a/./b',
      'x.drawio',
      'docs/x.drawio.svg',
    ]) {
      const error = exportPathError(path);

      assert.equal(typeof error, 'string', path.slice(0, 40));
      assert.notEqual(error, '', path.slice(0, 40));
    }
    for (const path of [
      'docs/diagrams/fluxo',
      'fluxo',
      'docs/v1.2/fluxo',
      'a'.repeat(512),
    ]) {
      assert.equal(exportPathError(path), undefined, path.slice(0, 40));
    }

    for (const svg of [
      '<html><body/></html>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      `<svg content="x">${'a'.repeat(MAX_SVG_BYTES)}</svg>`,
    ]) {
      const error = exportSvgError(svg);

      assert.equal(typeof error, 'string', svg.slice(0, 40));
      assert.notEqual(error, '', svg.slice(0, 40));
    }
    for (const svg of [EXPORT_SVG, '  <svg content="x"/>']) {
      assert.equal(exportSvgError(svg), undefined, svg);
    }
  });

  test('E11: a failed .drawio.svg write removes the .drawio just written and is internal', async () => {
    const h = exporting({ dirs: FOLDERS, failWrites: [ABS_SVG] });

    await assert.rejects(
      h.export(),
      rejection('internal', `Could not write ${REL_SVG}: disk full`),
    );
    assert.equal(h.sandbox.exists(ABS_DRAWIO), false, '.drawio is removed');
    assert.equal(h.sandbox.exists(ABS_SVG), false);
    assert.ok(
      h.sandbox.execs.some(
        (cmd) =>
          JSON.stringify(cmd) ===
          JSON.stringify(['rm', '-f', '--', ABS_DRAWIO]),
      ),
      'rm -f -- <.drawio> was run',
    );
    h.assertNoReads();
  });

  test('E11b: a failed .drawio write is internal, writes nothing and removes nothing', async () => {
    const h = exporting({ dirs: FOLDERS, failWrites: [ABS_DRAWIO] });

    await assert.rejects(
      h.export(),
      rejection('internal', `Could not write ${REL_DRAWIO}: disk full`),
    );
    h.assertNothingWritten();
    assert.equal(h.sandbox.exists(ABS_DRAWIO), false);
    assert.equal(h.sandbox.exists(ABS_SVG), false);
    assert.equal(
      h.sandbox.execs.some((cmd) => cmd[0] === 'rm'),
      false,
      'no rm',
    );
    h.assertNoReads();
  });

  test('E12: an unknown revision or artifact is not_found, and nothing is checked or written', async () => {
    for (const [input, message] of [
      [{ revision: 9 }, 'Revision 9 of fluxo-1 does not exist.'],
      [{ artifactId: 'nope-1' }, 'Revision 2 of nope-1 does not exist.'],
    ] as const) {
      const h = exporting({ dirs: FOLDERS });

      await assert.rejects(
        h.export(input),
        rejection('not_found', message),
        JSON.stringify(input),
      );
      assert.deepEqual(h.sandbox.execs, [], 'nothing is checked');
      h.assertNothingWritten();
      h.assertNoReads();
    }
  });

  test('E13: without a lease it is unavailable with the lease state, writing nothing', async () => {
    for (const lease of [
      'pending',
      'unavailable',
      'expired',
      'missing',
    ] as const satisfies readonly LeaseStatus[]) {
      const h = exporting({ dirs: FOLDERS, lease });

      await assert.rejects(
        h.export(),
        rejection('unavailable', undefined, { lease }),
      );
      h.assertNothingWritten();
      h.assertNoReads();
    }
  });

  test('E14: export is exposed to the desktop, and its input and output are closed', () => {
    assert.equal(drawioDiagramsMethods.export.expose, 'desktop');

    const input = {
      artifactId: 'fluxo-1',
      revision: 2,
      path: 'docs/diagrams/fluxo',
      svg: EXPORT_SVG,
      overwrite: false,
    };

    assert.ok(diagramExportInputSchema.safeParse(input).success);
    assert.equal(
      diagramExportInputSchema.safeParse({ ...input, extra: 1 }).success,
      false,
    );

    for (const answer of [
      { status: 'written', files: [REL_DRAWIO, REL_SVG] },
      { status: 'exists', files: [REL_SVG] },
      { status: 'blocked', path: REL_SVG, reason: 'directory' },
      { status: 'blocked', path: REL_SVG, reason: 'special' },
      { status: 'blocked', path: 'docs', reason: 'not-a-folder' },
    ]) {
      assert.ok(
        exportResultSchema.safeParse(answer).success,
        JSON.stringify(answer),
      );
    }
    for (const answer of [
      { status: 'written', files: [REL_DRAWIO, REL_SVG], extra: 1 },
      { status: 'exists', files: [REL_SVG], path: 'x' },
      { status: 'blocked', path: REL_SVG, reason: 'directory', files: [] },
      { status: 'blocked', path: REL_SVG, reason: 'other' },
      { status: 'unknown' },
    ]) {
      assert.equal(
        exportResultSchema.safeParse(answer).success,
        false,
        JSON.stringify(answer),
      );
    }
  });
});
