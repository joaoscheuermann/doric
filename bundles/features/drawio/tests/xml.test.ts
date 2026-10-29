// `normalizeDiagram`, at its public boundary: the text of a draw.io file in,
// the normalized `mxfile` and its pages out, or a model-readable refusal.
//
// Contract matrix (spec "Validação e normalização", plan §5 X1–X16):
// - an `mxfile` or a bare `mxGraphModel` becomes one uncompressed `mxfile`,
//   with page ids and names filled in;
// - size (UTF-8 bytes), DOCTYPE/ENTITY, malformed XML, the root, the page
//   count and the page ids are refused at their boundaries;
// - compressed pages are inflated to text, within the byte ceiling;
// - cells: `<root>`, the cell ceiling, ids and parents;
// - the source attributes survive, the output is a fixed point, and the
//   largest accepted input fits the 250 ms budget.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { DOMParser } from '@xmldom/xmldom';

import {
  MAX_CELLS,
  MAX_DIAGRAM_BYTES,
  MAX_PAGES,
  type PageSummary,
} from '../src/contracts/index.js';
import { normalizeDiagram } from '../src/host/xml.js';

/* Builders ------------------------------------------------------------------- */

/** The two root cells every draw.io page has, plus the given cells. */
const model = (cells = ''): string =>
  `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;

const vertex = (id: string, value = ''): string =>
  `<mxCell id="${id}" value="${value}" parent="1" vertex="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>`;

const page = (attrs: string, body: string): string =>
  `<diagram${attrs === '' ? '' : ` ${attrs}`}>${body}</diagram>`;

const mxfile = (pages: readonly string[], attrs = ''): string =>
  `<mxfile${attrs === '' ? '' : ` ${attrs}`}>${pages.join('')}</mxfile>`;

/** The form draw.io writes a compressed page in. */
const compress = (xml: string): string =>
  deflateRawSync(Buffer.from(encodeURIComponent(xml), 'utf8')).toString(
    'base64',
  );

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/* Observations --------------------------------------------------------------- */

type Accepted = {
  readonly xml: string;
  readonly pages: readonly PageSummary[];
};

const accepted = (text: string): Accepted => {
  const result = normalizeDiagram(text);

  assert.ok(
    'xml' in result,
    `expected acceptance, got: ${'error' in result ? result.error : ''}`,
  );

  return result;
};

const refused = (text: string): string => {
  const result = normalizeDiagram(text);

  assert.ok('error' in result, 'expected a refusal');
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0, 'the refusal has a reason');

  return result.error;
};

/** The output, parsed: what a reader of the stored file sees. */
const parsed = (xml: string) =>
  new DOMParser().parseFromString(xml, 'text/xml');

const diagramsOf = (xml: string) => {
  const root = parsed(xml).documentElement;

  assert.ok(root);

  return Array.from(root.childNodes).filter(
    (node): node is Element => node.nodeType === 1,
  );
};

/* Tests ---------------------------------------------------------------------- */

describe('normalizeDiagram', () => {
  test('X1: an mxfile with two text pages is kept as an uncompressed mxfile, with its pages summarized', () => {
    const result = accepted(
      mxfile([
        page('id="p1" name="A"', model(vertex('a') + vertex('b'))),
        page('id="p2" name="B"', model()),
      ]),
    );

    assert.ok(result.xml.startsWith('<mxfile'));
    assert.ok(!result.xml.startsWith('<?xml'), 'no XML declaration');
    assert.equal(
      parsed(result.xml).documentElement?.getAttribute('compressed'),
      'false',
    );
    assert.deepEqual(result.pages, [
      { id: 'p1', name: 'A', cells: 4 },
      { id: 'p2', name: 'B', cells: 2 },
    ]);
  });

  test('X2: a bare mxGraphModel is wrapped in one page named "Página 1"', () => {
    const result = accepted(model(vertex('a')));

    const [diagram, ...others] = diagramsOf(result.xml);
    assert.equal(parsed(result.xml).documentElement?.tagName, 'mxfile');
    assert.equal(others.length, 0);
    assert.equal(diagram?.tagName, 'diagram');
    assert.equal(diagram?.getAttribute('id'), 'page-1');
    assert.equal(diagram?.getAttribute('name'), 'Página 1');
    assert.deepEqual(result.pages, [
      { id: 'page-1', name: 'Página 1', cells: 3 },
    ]);
  });

  test('X3: a page without id or name gets page-<n> and "Página <n>"', () => {
    const result = accepted(
      mxfile([page('id="p1" name="A"', model()), page('', model())]),
    );

    assert.deepEqual(result.pages[1], {
      id: 'page-2',
      name: 'Página 2',
      cells: 2,
    });
    assert.equal(diagramsOf(result.xml)[1]?.getAttribute('id'), 'page-2');
    assert.equal(diagramsOf(result.xml)[1]?.getAttribute('name'), 'Página 2');
  });

  test('X4: the size ceiling counts UTF-8 bytes, not characters', () => {
    const frame = mxfile([page('id="p1" name="A"', model(vertex('a', '')))]);
    // Each "é" is two bytes: under the ceiling in characters, over it in bytes.
    const value = 'é'.repeat(Math.ceil(MAX_DIAGRAM_BYTES / 2) + 16);
    const text = mxfile([page('id="p1" name="A"', model(vertex('a', value)))]);

    assert.ok(
      text.length < MAX_DIAGRAM_BYTES,
      'fixture: under the ceiling in characters',
    );
    assert.ok(
      utf8Bytes(text) > MAX_DIAGRAM_BYTES,
      'fixture: over the ceiling in bytes',
    );
    accepted(frame);
    refused(text);
  });

  test('X5: DOCTYPE and ENTITY are refused, in any case, also inside a compressed page', () => {
    refused(`<!DOCTYPE mxfile>${mxfile([page('id="p1"', model())])}`);
    refused(
      `<!doctype mxfile [<!entity x "y">]>${mxfile([page('id="p1"', model())])}`,
    );
    refused(mxfile([page('id="p1"', `<!-- <!entity x "y"> -->${model()}`)]));
    refused(
      mxfile([page('id="p1"', compress(`<!DOCTYPE mxGraphModel>${model()}`))]),
    );
    refused(mxfile([page('id="p1"', compress(`<!ENTITY x "y">${model()}`))]));
  });

  test('X6: malformed XML and empty text are refused', () => {
    refused(`<mxfile><diagram id="p1">${model()}`);
    refused(`<mxfile><diagram id="p1">${model()}</mxfile>`);
    refused(`${mxfile([page('id="p1"', model())])}<junk/>`);
    refused('');
  });

  test('X7: a root other than mxfile or mxGraphModel is refused', () => {
    refused('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');
  });

  test('X8: from 1 to MAX_PAGES pages', () => {
    const pages = (n: number) =>
      Array.from({ length: n }, (_, i) => page(`id="p${i + 1}"`, model()));

    refused(mxfile([]));
    refused(mxfile(pages(MAX_PAGES + 1)));
    assert.equal(accepted(mxfile(pages(MAX_PAGES))).pages.length, MAX_PAGES);
  });

  test('X9: page ids are unique, without "/", and at most 128 characters', () => {
    refused(mxfile([page('id="p1"', model()), page('id="p1"', model())]));
    refused(mxfile([page('id="a/b"', model())]));
    refused(mxfile([page(`id="${'x'.repeat(129)}"`, model())]));
    assert.equal(
      accepted(mxfile([page(`id="${'x'.repeat(128)}"`, model())])).pages[0]?.id,
      'x'.repeat(128),
    );
  });

  test('X10: a compressed page becomes the same mxGraphModel text as its uncompressed equivalent', () => {
    const body = model(vertex('a', 'Olá &amp; até'));
    const plain = accepted(mxfile([page('id="p1" name="A"', body)]));
    const packed = accepted(mxfile([page('id="p1" name="A"', compress(body))]));

    assert.ok(packed.xml.includes('<mxGraphModel'));
    assert.equal(packed.xml, plain.xml);
    assert.deepEqual(packed.pages, plain.pages);
  });

  test('X11: bad compression and decompressed text over the ceiling are refused', () => {
    refused(mxfile([page('id="p1"', '!!! not base64 !!!')]));
    refused(
      mxfile([
        page('id="p1"', Buffer.from('not deflate data').toString('base64')),
      ]),
    );

    // One page that inflates past the ceiling on its own.
    const huge = model(vertex('a', 'a'.repeat(MAX_DIAGRAM_BYTES + 16)));
    const one = mxfile([page('id="p1"', compress(huge))]);
    assert.ok(utf8Bytes(one) < MAX_DIAGRAM_BYTES, 'fixture: small compressed');
    refused(one);

    // Two pages, each under the ceiling, whose sum is over it.
    const half = (id: string) =>
      model(vertex(id, 'a'.repeat(Math.ceil(MAX_DIAGRAM_BYTES * 0.6))));
    const two = mxfile([
      page('id="p1"', compress(half('a'))),
      page('id="p2"', compress(half('b'))),
    ]);
    assert.ok(
      utf8Bytes(half('a')) < MAX_DIAGRAM_BYTES,
      'fixture: each page under',
    );
    refused(two);
  });

  test('X12: cells need a <root>, fit MAX_CELLS, and have non-empty, short, unique ids per page', () => {
    refused(mxfile([page('id="p1"', '<mxGraphModel></mxGraphModel>')]));

    // MAX_CELLS summed over pages: two pages of 2 root cells plus vertices.
    const pagesWith = (total: number) => {
      const first = Math.floor(total / 2);
      const cells = (from: number, count: number) =>
        Array.from({ length: count - 2 }, (_, i) =>
          vertex(`c${from + i}`),
        ).join('');

      return mxfile([
        page('id="p1"', model(cells(0, first))),
        page('id="p2"', model(cells(first, total - first))),
      ]);
    };
    assert.equal(
      accepted(pagesWith(MAX_CELLS)).pages.reduce((sum, p) => sum + p.cells, 0),
      MAX_CELLS,
    );
    refused(pagesWith(MAX_CELLS + 1));

    refused(mxfile([page('id="p1"', model(vertex('')))]));
    refused(mxfile([page('id="p1"', model(vertex('i'.repeat(129))))]));

    assert.equal(
      refused(
        mxfile([
          page('id="page-1"', model(vertex('a1'))),
          page('id="page-2"', model(vertex('a1') + vertex('a1'))),
        ]),
      ),
      'Page "page-2" has two cells with id "a1".',
    );
    // The id of an object or UserObject is the wrapper's.
    refused(
      mxfile([
        page(
          'id="p1"',
          model(
            `${vertex('a1')}<object id="a1" label="x"><mxCell parent="1" vertex="1"/></object>`,
          ),
        ),
      ]),
    );
    refused(
      mxfile([
        page(
          'id="p1"',
          model(
            `${vertex('a1')}<UserObject id="a1" label="x"><mxCell parent="1" vertex="1"/></UserObject>`,
          ),
        ),
      ]),
    );
    // The same id on different pages is fine.
    accepted(
      mxfile([
        page('id="p1"', model(vertex('a1'))),
        page('id="p2"', model(vertex('a1'))),
      ]),
    );
  });

  test("X13: every parent exists on its page, except the root cell; an object's mxCell parent is checked", () => {
    refused(
      mxfile([
        page('id="p1"', model('<mxCell id="a" parent="zz" vertex="1"/>')),
      ]),
    );
    assert.deepEqual(
      accepted(
        mxfile([
          page(
            'id="p1"',
            '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>',
          ),
        ]),
      ).pages,
      [{ id: 'p1', name: 'Página 1', cells: 1 }],
    );
    refused(
      mxfile([
        page(
          'id="p1"',
          model(
            '<object id="o1" label="x"><mxCell parent="nope" vertex="1"/></object>',
          ),
        ),
      ]),
    );
    accepted(
      mxfile([
        page(
          'id="p1"',
          model(
            '<object id="o1" label="x"><mxCell parent="1" vertex="1"/></object>',
          ),
        ),
      ]),
    );
  });

  test('X14: the mxfile source attributes are kept and compressed becomes "false"', () => {
    const result = accepted(
      mxfile(
        [page('id="p1" name="A"', compress(model()))],
        'host="Electron" agent="Mozilla/5.0" version="24.7.17" compressed="true"',
      ),
    );
    const root = parsed(result.xml).documentElement;

    assert.ok(root);

    assert.equal(root.getAttribute('host'), 'Electron');
    assert.equal(root.getAttribute('agent'), 'Mozilla/5.0');
    assert.equal(root.getAttribute('version'), '24.7.17');
    assert.equal(root.getAttribute('compressed'), 'false');
  });

  test('X15: normalizing is deterministic and its output is a fixed point', () => {
    const input = mxfile(
      [
        page('id="p1" name="A"', compress(model(vertex('a', 'x')))),
        page('', model(vertex('b'))),
      ],
      'host="app.diagrams.net" compressed="true"',
    );
    const first = accepted(input);

    assert.equal(accepted(input).xml, first.xml);
    assert.equal(accepted(first.xml).xml, first.xml);
    assert.deepEqual(accepted(first.xml).pages, first.pages);
  });

  test('X16: the largest accepted input normalizes in under 250 ms', () => {
    // A deterministic generator of hex text: low compressibility (4 bits a
    // character), and nothing `encodeURIComponent` expands.
    let seed = 0x2f6b_1d3a;
    const hex = (length: number): string => {
      let out = '';
      for (let i = 0; i < length; i += 1) {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        out += (seed >>> 28).toString(16);
      }
      return out;
    };

    const cellsPerPage = MAX_CELLS / MAX_PAGES; // 100: 2 root cells + 98 vertices
    const pageBytes = Math.floor((MAX_DIAGRAM_BYTES * 0.995) / MAX_PAGES);
    const vertices = cellsPerPage - 2;
    const pageModel = (p: number): string => {
      const empty = model(
        Array.from({ length: vertices }, (_, i) => vertex(`p${p}c${i}`)).join(
          '',
        ),
      );
      const room = pageBytes - utf8Bytes(empty);
      const each = Math.floor(room / vertices);
      const last = room - each * (vertices - 1);

      return model(
        Array.from({ length: vertices }, (_, i) =>
          vertex(`p${p}c${i}`, hex(i === vertices - 1 ? last : each)),
        ).join(''),
      );
    };
    const models = Array.from({ length: MAX_PAGES }, (_, p) => pageModel(p));
    const input = mxfile(
      models.map((m, p) => page(`id="p${p}" name="P${p}"`, compress(m))),
    );

    const decompressed = models.reduce((sum, m) => sum + utf8Bytes(m), 0);
    assert.ok(
      decompressed >= MAX_DIAGRAM_BYTES * 0.99,
      'fixture: ≥ 99% of the ceiling',
    );
    assert.ok(decompressed <= MAX_DIAGRAM_BYTES, 'fixture: within the ceiling');
    assert.ok(
      utf8Bytes(input) <= MAX_DIAGRAM_BYTES,
      'fixture: input within the ceiling',
    );

    accepted(input); // warm-up
    const start = performance.now();
    const result = accepted(input);
    const elapsed = performance.now() - start;

    assert.equal(
      result.pages.reduce((sum, p) => sum + p.cells, 0),
      MAX_CELLS,
    );
    assert.ok(elapsed < 250, `normalizeDiagram took ${elapsed.toFixed(1)} ms`);
  });
});
