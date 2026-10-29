// vendor() turns a pinned draw.io source archive into the webapp main serves
// at the editor origin: verified by SHA-256, cached only once verified, the
// server and template folders left out, the license kept, and a manifest of
// every file's hash. The network is the `download` option; the archive is a
// fixture built here, laid out as GitHub's tag archive is.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { create } from 'tar';

import { vendor } from '../vendor.mjs';

const VERSION = '32.6.1';
const TOP = `drawio-${VERSION}`;
const ARCHIVE_URL = `https://github.com/jgraph/drawio/archive/refs/tags/v${VERSION}.tar.gz`;
const EXCLUDE = ['WEB-INF/', 'META-INF/', 'templates/'];
const LICENSE = 'Apache License, Version 2.0 (fixture)';
const NOTICE = 'draw.io NOTICE (fixture)';

/** The webapp files that must reach `<out>/webapp/`, by POSIX path. */
const KEPT = {
  'index.html': '<!doctype html><title>draw.io</title>',
  'js/app.min.js': 'void "app";',
  'stencils/basic.xml': '<shapes name="basic"/>',
  'img/lib/active_directory/user.svg':
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'shapes/mxAWS4.js': 'void "aws4";',
};
/** The webapp files the lock excludes. */
const EXCLUDED = {
  'WEB-INF/web.xml': '<web-app/>',
  'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0',
  'templates/basic/flowchart.xml': '<mxfile/>',
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const filesUnder = async (dir) => {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(path);
      } else {
        found.push(relative(dir, path).split(sep).join('/'));
      }
    }
  };

  await walk(dir);

  return found.sort();
};

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

const writeTree = async (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
};

let scratch;

/** A gzipped tag archive with `drawio-32.6.1/` on top; returns its bytes. */
const archive = async (name, { notice = false } = {}) => {
  const source = join(scratch, `${name}-source`);
  const file = join(scratch, `${name}.tar.gz`);
  const webapp = Object.fromEntries(
    Object.entries({ ...KEPT, ...EXCLUDED }).map(([path, content]) => [
      `${TOP}/src/main/webapp/${path}`,
      content,
    ]),
  );

  await writeTree(source, {
    ...webapp,
    [`${TOP}/LICENSE`]: LICENSE,
    ...(notice ? { [`${TOP}/NOTICE`]: NOTICE } : {}),
    [`${TOP}/README.md`]: '# draw.io',
    [`${TOP}/src/main/java/Server.java`]: 'class Server {}',
  });
  await create({ gzip: true, file, cwd: source, portable: true }, [TOP]);

  return readFile(file);
};

const lockFor = (bytes) => ({
  version: VERSION,
  url: ARCHIVE_URL,
  sha256: sha256(bytes),
  exclude: EXCLUDE,
});

/** A `download` that must never run. */
const noDownload = () => {
  const calls = [];
  const download = async (url) => {
    calls.push(url);
    throw new Error('download must not be called');
  };

  return { calls, download };
};

/** Fresh `out` and `cacheDir` directories under the scratch folder. */
const dirs = async () => {
  const base = await mkdtemp(join(scratch, 'run-'));

  return { out: join(base, 'out'), cacheDir: join(base, 'cache') };
};

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'drawio-vendor-'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('vendor from a cached archive whose SHA-256 matches', () => {
  test('writes the webapp without the excluded folders, the license and a manifest, without downloading', async () => {
    const bytes = await archive('cached');
    const lock = lockFor(bytes);
    const { out, cacheDir } = await dirs();
    const { calls, download } = noDownload();

    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${lock.sha256}.tar.gz`), bytes);
    // A previous webapp: replaced entirely.
    await writeTree(join(out, 'webapp'), { 'stale.js': 'old' });

    const manifest = await vendor({ lock, out, cacheDir, download });

    assert.deepEqual(
      await filesUnder(join(out, 'webapp')),
      Object.keys(KEPT).sort(),
    );
    assert.equal(await readFile(join(out, 'LICENSE'), 'utf8'), LICENSE);
    assert.equal(await exists(join(out, 'NOTICE')), false);
    assert.equal(manifest.version, VERSION);
    assert.deepEqual(
      manifest.files,
      Object.fromEntries(
        Object.entries(KEPT).map(([path, content]) => [path, sha256(content)]),
      ),
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')),
      manifest,
    );
    assert.deepEqual(calls, []);
  });

  test('copies NOTICE beside LICENSE when the archive has one', async () => {
    const bytes = await archive('noticed', { notice: true });
    const lock = lockFor(bytes);
    const { out, cacheDir } = await dirs();

    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${lock.sha256}.tar.gz`), bytes);
    await vendor({ lock, out, cacheDir, download: noDownload().download });

    assert.equal(await readFile(join(out, 'LICENSE'), 'utf8'), LICENSE);
    assert.equal(await readFile(join(out, 'NOTICE'), 'utf8'), NOTICE);
  });
});

describe('vendor from a cached archive whose SHA-256 does not match', () => {
  test('rejects naming both hashes and writes no manifest', async () => {
    const bytes = await archive('tampered');
    const expected = 'f'.repeat(64);
    const lock = { ...lockFor(bytes), sha256: expected };
    const { out, cacheDir } = await dirs();

    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${expected}.tar.gz`), bytes);

    await assert.rejects(
      vendor({ lock, out, cacheDir, download: noDownload().download }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(expected));
        assert.match(error.message, new RegExp(sha256(bytes)));

        return true;
      },
    );
    assert.equal(await exists(join(out, 'manifest.json')), false);
  });

  test('leaves a previous out untouched', async () => {
    const bytes = await archive('tampered-again');
    const expected = 'e'.repeat(64);
    const lock = { ...lockFor(bytes), sha256: expected };
    const { out, cacheDir } = await dirs();
    const previous = JSON.stringify({ version: '1.0.0', files: {} });

    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${expected}.tar.gz`), bytes);
    await writeTree(out, {
      'manifest.json': previous,
      'webapp/index.html': 'previous',
    });

    await assert.rejects(
      vendor({ lock, out, cacheDir, download: noDownload().download }),
    );
    assert.equal(await readFile(join(out, 'manifest.json'), 'utf8'), previous);
    assert.deepEqual(await filesUnder(join(out, 'webapp')), ['index.html']);
    assert.equal(
      await readFile(join(out, 'webapp', 'index.html'), 'utf8'),
      'previous',
    );
  });
});

describe('vendor without a cached archive', () => {
  test('downloads the lock url and caches the verified archive under its SHA-256', async () => {
    const bytes = await archive('downloaded');
    const lock = lockFor(bytes);
    const { out, cacheDir } = await dirs();
    const requested = [];

    const manifest = await vendor({
      lock,
      out,
      cacheDir,
      download: async (url) => {
        requested.push(url);

        return new Response(bytes, { status: 200 });
      },
    });

    assert.deepEqual(requested, [ARCHIVE_URL]);
    assert.equal(manifest.version, VERSION);
    assert.deepEqual(
      await readFile(join(cacheDir, `${lock.sha256}.tar.gz`)),
      bytes,
    );
    assert.deepEqual(
      await filesUnder(join(out, 'webapp')),
      Object.keys(KEPT).sort(),
    );
  });

  test('accepts a download that is a stream of chunks', async () => {
    const bytes = await archive('streamed');
    const lock = lockFor(bytes);
    const { out, cacheDir } = await dirs();

    const manifest = await vendor({
      lock,
      out,
      cacheDir,
      download: async () =>
        (async function* () {
          yield new Uint8Array(bytes.subarray(0, 100));
          yield new Uint8Array(bytes.subarray(100));
        })(),
    });

    assert.equal(manifest.version, VERSION);
    assert.deepEqual(
      await readFile(join(cacheDir, `${lock.sha256}.tar.gz`)),
      bytes,
    );
  });

  test('a download with another SHA-256 rejects and caches nothing', async () => {
    const bytes = await archive('swapped');
    const lock = { ...lockFor(bytes), sha256: 'd'.repeat(64) };
    const { out, cacheDir } = await dirs();

    await assert.rejects(
      vendor({
        lock,
        out,
        cacheDir,
        download: async () => new Response(bytes, { status: 200 }),
      }),
    );
    assert.deepEqual(
      (await exists(cacheDir)) ? await filesUnder(cacheDir) : [],
      [],
    );
    assert.equal(await exists(join(out, 'manifest.json')), false);
  });
});
