// `drawio.svg/v1` (desktopMain): the cache of the pages the client drew and
// measured. A `put` stores one page's SVG and layout under its key, a `get`
// with the same key answers them, and anything the cache cannot trust reads
// as absent. The cache lives in a temporary directory handed in as the
// bundle's `doric.cache/v1` directory; the editor origin's `describe` is
// faked at its boundary.
//
// Contract matrix (plan §3, tests 1–9):
// - round trip and file layout (1), absence (2), damaged files (3);
// - keys that differ in one field are independent (4);
// - page ids that are not file names stay inside the key's directory (5);
// - every off-schema input is refused before anything is written (6);
// - an SVG with an XML declaration is still an SVG (7);
// - a second `put` replaces the first (8);
// - `status` passes `describe` through (9).
//
// Q7 (the first-page pointer, step 3c contracts): `get` answers the entry with
// its `pageId`; a `put` with `first: true` records the page as the revision's
// first, in `first-page.json`, for every theme; a `get` without `pageId`
// follows that pointer (P1–P12).

import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { type DrawioDescription, isContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import {
  type DiagramLayout,
  type DiagramSvgEntry,
  type DiagramSvgKey,
  type DiagramSvgLookup,
  type DiagramSvgPut,
  DrawioSvgV1,
  MAX_CELLS,
  MAX_SVG_BYTES,
} from '../src/contracts/index.js';
import { DiagramSvgCache, svgCacheService } from '../src/desktop/svg-cache.js';

const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_SHA =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

const KEY: DiagramSvgKey = {
  artifactId: 'a-1',
  revision: 3,
  sha256: SHA,
  pageId: 'p1',
  theme: 'light',
};

/** `KEY`'s revision and theme, without a page: the first-page lookup. */
const FIRST: DiagramSvgLookup = {
  artifactId: 'a-1',
  revision: 3,
  sha256: SHA,
  theme: 'light',
};

const LAYOUT: DiagramLayout = {
  width: 400,
  height: 300,
  cells: [
    { id: 'c1', x: 10, y: 20, width: 120, height: 60 },
    { id: 'c2', x: 200.5, y: 20, width: 120, height: 60 },
  ],
};

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g data-cell-id="c1"/></svg>';

const ENTRY: DiagramSvgEntry = { svg: SVG, layout: LAYOUT };

/** The directory every file of `KEY`'s revision and hash lives in. */
const KEY_DIR = join('svg', 'a-1@3', SHA);

/** The first-page pointer of `KEY`'s revision and hash. */
const POINTER = join(KEY_DIR, 'first-page.json');

/** A second entry, distinguishable from `ENTRY`. */
const OTHER: DiagramSvgEntry = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" data-other="yes"></svg>',
  layout: { width: 20, height: 10, cells: [] },
};

/**
 * `drawio.svg/v1` as a window reaches it, over a cache rooted in a fresh
 * temporary directory.
 */
const harnessOf = async (describe?: () => Promise<DrawioDescription>) => {
  const root = await mkdtemp(join(tmpdir(), 'drawio-svg-'));
  const harness = createTestServices({ bundle: { id: 'drawio' } });

  try {
    harness.services.provide(
      svgCacheService({
        directory: () => Promise.resolve(root),
        ...(describe === undefined ? {} : { describe: () => describe() }),
      }),
    );
  } catch (error) {
    await harness.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  const api = harness.services.use(DrawioSvgV1);

  return {
    root,
    // `async` turns a synchronous input refusal into the rejection a window sees.
    get: async (lookup: unknown) => api.get(lookup as DiagramSvgLookup),
    put: async (input: unknown) => api.put(input as DiagramSvgPut),
    status: async () => api.status(),
    dispose: async () => {
      await harness.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
};

type Harness = Awaited<ReturnType<typeof harnessOf>>;

const withHarness = async (
  body: (harness: Harness) => Promise<void>,
  describe?: () => Promise<DrawioDescription>,
) => {
  const harness = await harnessOf(describe);

  try {
    await body(harness);
  } finally {
    await harness.dispose();
  }
};

/** Every file under `dir`, relative to it, sorted. */
const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
};

/** The contract error code a rejected call fails with. */
const codeOf = async (pending: Promise<unknown>): Promise<string> => {
  try {
    await pending;
  } catch (error) {
    assert.ok(isContractError(error), String(error));

    return error.code;
  }

  assert.fail('the call succeeded');
};

test('a put page reads back under its key, as one SVG file and one layout file', async () => {
  await withHarness(async (cache) => {
    await cache.put({ ...KEY, ...ENTRY });

    assert.deepEqual(await cache.get(KEY), { ...ENTRY, pageId: KEY.pageId });
    assert.deepEqual(await filesUnder(cache.root), [
      join(KEY_DIR, 'p1.light.layout.json'),
      join(KEY_DIR, 'p1.light.svg'),
    ]);
  });
});

test('a key nothing was put under reads as null', async () => {
  await withHarness(async (cache) => {
    assert.equal(await cache.get(KEY), null);

    await cache.put({ ...KEY, ...ENTRY });

    assert.equal(await cache.get({ ...KEY, revision: 4 }), null);
  });
});

test('an entry whose files are missing or damaged reads as null', async () => {
  const damages: Record<string, (root: string) => Promise<void>> = {
    'layout missing': (root) =>
      unlink(join(root, KEY_DIR, 'p1.light.layout.json')),
    'layout not JSON': (root) =>
      writeFile(join(root, KEY_DIR, 'p1.light.layout.json'), '{"width":'),
    'layout off-schema': (root) =>
      writeFile(
        join(root, KEY_DIR, 'p1.light.layout.json'),
        JSON.stringify({ width: -1, height: 300, cells: [] }),
      ),
    'svg missing': (root) => unlink(join(root, KEY_DIR, 'p1.light.svg')),
  };

  for (const [name, damage] of Object.entries(damages)) {
    await withHarness(async (cache) => {
      await cache.put({ ...KEY, ...ENTRY });
      await damage(cache.root);

      assert.equal(await cache.get(KEY), null, name);
    });
  }
});

test('keys that differ only in theme, page or hash hold independent entries', async () => {
  const keys: readonly DiagramSvgKey[] = [
    KEY,
    { ...KEY, theme: 'dark' },
    { ...KEY, pageId: 'p2' },
    { ...KEY, sha256: OTHER_SHA },
  ];
  const entryOf = (index: number): DiagramSvgEntry => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" data-n="${index}"></svg>`,
    layout: { width: 100 + index, height: 50, cells: [] },
  });

  await withHarness(async (cache) => {
    for (const [index, key] of keys.entries()) {
      await cache.put({ ...key, ...entryOf(index) });
    }

    for (const [index, key] of keys.entries()) {
      assert.deepEqual(
        await cache.get(key),
        { ...entryOf(index), pageId: key.pageId },
        JSON.stringify(key),
      );
    }
  });
});

test('a page id that is not a file name is encoded inside the key directory', async () => {
  for (const pageId of ['a/b', '..', '%']) {
    await withHarness(async (cache) => {
      const key = { ...KEY, pageId };

      await cache.put({ ...key, ...ENTRY });

      assert.deepEqual(await cache.get(key), { ...ENTRY, pageId }, pageId);
      assert.deepEqual(
        await filesUnder(cache.root),
        [
          join(KEY_DIR, `${encodeURIComponent(pageId)}.light.layout.json`),
          join(KEY_DIR, `${encodeURIComponent(pageId)}.light.svg`),
        ],
        pageId,
      );
    });
  }
});

test('a put off the contract is refused and writes nothing', async () => {
  const cell = { id: 'c1', x: 10, y: 20, width: 120, height: 60 };
  const tooManyCells = Array.from({ length: MAX_CELLS + 1 }, (_, index) => ({
    ...cell,
    id: `c${index}`,
  }));
  // Fewer characters than MAX_SVG_BYTES, more bytes in UTF-8 ('é' is 2 bytes).
  const overBytes = `<svg>${'é'.repeat(MAX_SVG_BYTES / 2)}</svg>`;

  const inputs: Record<string, unknown> = {
    'bad artifactId': { ...KEY, ...ENTRY, artifactId: '../A 1' },
    'bad sha': { ...KEY, ...ENTRY, sha256: SHA.toUpperCase() },
    '129-character pageId': { ...KEY, ...ENTRY, pageId: 'x'.repeat(129) },
    'unknown theme': { ...KEY, ...ENTRY, theme: 'sepia' },
    'not an SVG': { ...KEY, ...ENTRY, svg: '<html><svg></svg></html>' },
    '<svgx> root': { ...KEY, ...ENTRY, svg: '<svgx></svgx>' },
    'SVG over MAX_SVG_BYTES in UTF-8': { ...KEY, ...ENTRY, svg: overBytes },
    'negative number': {
      ...KEY,
      ...ENTRY,
      layout: { ...LAYOUT, width: -1 },
    },
    'NaN number': {
      ...KEY,
      ...ENTRY,
      layout: { ...LAYOUT, cells: [{ ...cell, x: Number.NaN }] },
    },
    'Infinity number': {
      ...KEY,
      ...ENTRY,
      layout: { ...LAYOUT, height: Number.POSITIVE_INFINITY },
    },
    'empty cell id': {
      ...KEY,
      ...ENTRY,
      layout: { ...LAYOUT, cells: [{ ...cell, id: '' }] },
    },
    'MAX_CELLS + 1 cells': {
      ...KEY,
      ...ENTRY,
      layout: { ...LAYOUT, cells: tooManyCells },
    },
    'first: false': { ...KEY, ...ENTRY, first: false },
    "first: 'yes'": { ...KEY, ...ENTRY, first: 'yes' },
    'first: 1': { ...KEY, ...ENTRY, first: 1 },
  };

  await withHarness(async (cache) => {
    for (const [name, input] of Object.entries(inputs)) {
      assert.equal(await codeOf(cache.put(input)), 'invalid_input', name);
    }

    assert.deepEqual(await filesUnder(cache.root), []);
  });
});

test('an SVG after whitespace and an XML declaration is accepted', async () => {
  const svg =
    '  \n<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';

  await withHarness(async (cache) => {
    await cache.put({ ...KEY, svg, layout: LAYOUT });

    assert.deepEqual(await cache.get(KEY), {
      svg,
      layout: LAYOUT,
      pageId: KEY.pageId,
    });
  });
});

test('an SVG of exactly MAX_SVG_BYTES and MAX_CELLS cells is accepted', async () => {
  const svg = `<svg>${'x'.repeat(MAX_SVG_BYTES - 11)}</svg>`;
  const cells = Array.from({ length: MAX_CELLS }, (_, index) => ({
    id: `c${index}`,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  }));
  const layout = { ...LAYOUT, cells };

  await withHarness(async (cache) => {
    await cache.put({ ...KEY, svg, layout });

    assert.deepEqual(await cache.get(KEY), {
      svg,
      layout,
      pageId: KEY.pageId,
    });
  });
});

test('a second put under the same key replaces the first', async () => {
  const second: DiagramSvgEntry = {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" data-second="yes"></svg>',
    layout: { width: 10, height: 10, cells: [] },
  };

  await withHarness(async (cache) => {
    await cache.put({ ...KEY, ...ENTRY });
    await cache.put({ ...KEY, ...second });

    assert.deepEqual(await cache.get(KEY), {
      ...second,
      pageId: KEY.pageId,
    });
    assert.deepEqual(await filesUnder(cache.root), [
      join(KEY_DIR, 'p1.light.layout.json'),
      join(KEY_DIR, 'p1.light.svg'),
    ]);
  });
});

test('status answers what the editor origin describes, even when it is unavailable', async () => {
  const unavailable: DrawioDescription = {
    available: false,
    reason: 'missing-assets',
  };

  await withHarness(
    async (cache) => {
      assert.deepEqual(await cache.status(), unavailable);
    },
    () => Promise.resolve(unavailable),
  );
});

/* The first-page pointer (Q7) ------------------------------------------------ */

/** A `DiagramSvgCache` over a fresh temporary root, removed afterwards. */
const withCache = async (
  body: (cache: DiagramSvgCache, root: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), 'drawio-svg-'));

  try {
    await body(new DiagramSvgCache(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** The JSON of a file under `root`. */
const jsonAt = async (root: string, path: string): Promise<unknown> =>
  JSON.parse(await readFile(join(root, path), 'utf8')) as unknown;

test('P1: a put with first records the page, and a get without pageId answers it', async () => {
  await withCache(async (cache, root) => {
    await cache.put({ ...KEY, svg: SVG, layout: LAYOUT, first: true });

    assert.deepEqual(await jsonAt(root, POINTER), { pageId: KEY.pageId });
    assert.deepEqual(await cache.get(FIRST), {
      ...ENTRY,
      pageId: KEY.pageId,
    });
    assert.deepEqual(await filesUnder(root), [
      POINTER,
      join(KEY_DIR, 'p1.light.layout.json'),
      join(KEY_DIR, 'p1.light.svg'),
    ]);
  });
});

test('P2: a put without first records no first page', async () => {
  await withHarness(async (cache) => {
    await cache.put({ ...KEY, ...ENTRY });

    assert.ok(!(await filesUnder(cache.root)).includes(POINTER));
    assert.equal(await cache.get(FIRST), null);
    assert.deepEqual(await cache.get(KEY), { ...ENTRY, pageId: KEY.pageId });
  });
});

test('P3/P4: one pointer serves both themes, once the other theme has its entry', async () => {
  await withHarness(async (cache) => {
    const dark = { ...FIRST, theme: 'dark' };

    await cache.put({ ...KEY, ...ENTRY, first: true });

    assert.equal(await cache.get(dark), null, 'no dark entry yet');

    await cache.put({ ...KEY, theme: 'dark', ...OTHER });

    assert.deepEqual(await cache.get(dark), { ...OTHER, pageId: KEY.pageId });
  });
});

test('P5: a pointer whose entry lost a file reads as null', async () => {
  for (const file of ['p1.light.svg', 'p1.light.layout.json']) {
    await withHarness(async (cache) => {
      await cache.put({ ...KEY, ...ENTRY, first: true });
      await unlink(join(cache.root, KEY_DIR, file));

      assert.equal(await cache.get(FIRST), null, file);
    });
  }
});

test('P6: a damaged pointer reads as null, never a rejection', async () => {
  const pointers: Record<string, string> = {
    'not JSON': '{"pageId":',
    'empty object': '{}',
    'empty pageId': JSON.stringify({ pageId: '' }),
    'numeric pageId': JSON.stringify({ pageId: 7 }),
    '129-character pageId': JSON.stringify({ pageId: 'x'.repeat(129) }),
    'extra key': JSON.stringify({ pageId: 'p1', theme: 'light' }),
  };

  for (const [name, text] of Object.entries(pointers)) {
    await withHarness(async (cache) => {
      await cache.put({ ...KEY, ...ENTRY, first: true });
      await writeFile(join(cache.root, POINTER), text);

      assert.equal(await cache.get(FIRST), null, name);
    });
  }
});

test('P7: a pointer naming a page with no entry reads as null', async () => {
  await withHarness(async (cache) => {
    await cache.put({ ...KEY, ...ENTRY, first: true });
    await writeFile(
      join(cache.root, POINTER),
      JSON.stringify({ pageId: 'p9' }),
    );

    assert.equal(await cache.get(FIRST), null);
  });
});

test('P8: a later put with first for another page moves the pointer', async () => {
  await withHarness(async (cache) => {
    await cache.put({ ...KEY, ...ENTRY, first: true });
    await cache.put({ ...KEY, pageId: 'p2', ...OTHER, first: true });

    assert.deepEqual(await jsonAt(cache.root, POINTER), { pageId: 'p2' });
    assert.deepEqual(await cache.get(FIRST), { ...OTHER, pageId: 'p2' });
  });
});

test('P9: a refused put with first writes neither the entry nor the pointer', async () => {
  await withHarness(async (cache) => {
    const input = { ...KEY, ...ENTRY, svg: '<html></html>', first: true };

    assert.equal(await codeOf(cache.put(input)), 'invalid_input');
    assert.deepEqual(await filesUnder(cache.root), []);
  });
});

test('P10: an off-schema lookup is invalid_input through the service, null on the cache', async () => {
  const lookups: Record<string, unknown> = {
    'bad sha': { ...FIRST, sha256: SHA.toUpperCase() },
    'extra key': { ...FIRST, extra: 1 },
    'empty pageId': { ...FIRST, pageId: '' },
  };

  await withHarness(async (service) => {
    await withCache(async (cache) => {
      for (const [name, lookup] of Object.entries(lookups)) {
        assert.equal(await codeOf(service.get(lookup)), 'invalid_input', name);
        assert.equal(
          await cache.get(lookup as DiagramSvgLookup),
          null,
          `${name} (cache)`,
        );
      }
    });
  });
});

test("P11: firstPageFileOf is the revision directory's first-page.json, or undefined off-schema", async () => {
  await withCache(async (cache, root) => {
    const revision = { artifactId: 'a-1', revision: 3, sha256: SHA };

    assert.equal(cache.firstPageFileOf(revision), join(root, POINTER));
    assert.equal(
      cache.firstPageFileOf({ ...revision, artifactId: '../A 1' }),
      undefined,
    );
    assert.equal(
      cache.firstPageFileOf({ ...revision, revision: 0 }),
      undefined,
    );
    assert.equal(
      cache.firstPageFileOf({ ...revision, sha256: SHA.toUpperCase() }),
      undefined,
    );
  });
});

test('P12: through the service, a put with first is what a get without pageId answers', async () => {
  await withHarness(async (cache) => {
    await cache.put({ ...KEY, ...ENTRY, first: true });

    assert.deepEqual(await cache.get(FIRST), { ...ENTRY, pageId: KEY.pageId });
  });
});
