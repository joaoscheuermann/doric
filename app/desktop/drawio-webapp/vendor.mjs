// Vendors the draw.io webapp main serves at the editor origin
// (`DRAWIO_ORIGIN`): the pinned source archive of `drawio.lock.json`,
// verified by SHA-256 and cached once verified, unpacked without the server
// and template folders, its LICENSE (and NOTICE) kept, and a manifest of
// every served file's hash.
//
//   node app/desktop/drawio-webapp/vendor.mjs --out dist/app/desktop/doric/assets/drawio

import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { x } from 'tar';

/**
 * @typedef {object} DrawioLock
 * @property {string} version @property {string} url @property {string} sha256 @property {string[]} exclude
 * (relative to webapp/; a trailing / names a whole directory)
 */
/** @typedef {object} DrawioManifest @property {string} version @property {Record<string,string>} files */
/**
 * @typedef {object} VendorOptions
 * @property {DrawioLock} lock @property {string} out @property {string} cacheDir
 * @property {(url: string) => Promise<Response | AsyncIterable<Uint8Array>>} download
 */

/** Where the webapp sits in the tag archive, under its top folder. */
const WEBAPP = 'src/main/webapp/';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The bytes a download answered, from a Response or a stream of chunks. */
const bytesOf = async (answer, url) => {
  if (answer instanceof Response) {
    if (!answer.ok) {
      throw new Error(`Downloading ${url} failed: HTTP ${answer.status}.`);
    }

    return Buffer.from(await answer.arrayBuffer());
  }

  const chunks = [];

  for await (const chunk of answer) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

const verify = (bytes, lock, source) => {
  const actual = sha256(bytes);

  if (actual !== lock.sha256) {
    throw new Error(
      `The draw.io archive (${source}) has SHA-256 ${actual}, but drawio.lock.json expects ${lock.sha256}.`,
    );
  }
};

/** The verified archive: the cached copy, else a download cached once verified. */
const archiveOf = async ({ lock, cacheDir, download }) => {
  const cached = join(cacheDir, `${lock.sha256}.tar.gz`);

  if (await exists(cached)) {
    const bytes = await readFile(cached);

    verify(bytes, lock, cached);

    return bytes;
  }

  const bytes = await bytesOf(await download(lock.url), lock.url);

  verify(bytes, lock, lock.url);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cached, bytes);

  return bytes;
};

/** Whether a path relative to webapp/ is excluded by the lock. */
const excluded = (path, exclude) =>
  exclude.some((entry) =>
    entry.endsWith('/') ? `${path}/`.startsWith(entry) : path === entry,
  );

/** Whether an archive entry (under its top folder) is to be unpacked. */
const wanted = (entry, exclude) => {
  const path = entry.split('/').slice(1).join('/').replace(/\/$/u, '');

  if (path === 'LICENSE' || path === 'NOTICE') {
    return true;
  }

  return (
    path.startsWith(WEBAPP) && !excluded(path.slice(WEBAPP.length), exclude)
  );
};

/** Every file under a directory, by POSIX path relative to it, sorted. */
const filesUnder = async (dir) => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'),
    )
    .sort();
};

/**
 * Resolves with the manifest it wrote. Rejects, leaving no manifest.json in out, when:
 * - the archive's SHA-256 (cached or downloaded) differs from lock.sha256 (the message names both hashes);
 * - download returns a non-ok Response;
 * - the archive has no src/main/webapp/ or no LICENSE.
 * A downloaded archive is cached only after it verifies. <out>/webapp is replaced entirely.
 * Importing has no side effects; the CLI runs only as the entry point.
 * @param {VendorOptions} options @returns {Promise<DrawioManifest>}
 */
export async function vendor({ lock, out, cacheDir, download }) {
  const bytes = await archiveOf({ lock, cacheDir, download });

  await mkdir(dirname(resolve(out)), { recursive: true });

  const temporary = await mkdtemp(`${resolve(out)}.tmp-`);

  try {
    await pipeline(
      Readable.from([bytes]),
      x({
        cwd: temporary,
        strip: 1,
        filter: (path) => wanted(path, lock.exclude),
      }),
    );

    const webapp = join(temporary, ...WEBAPP.split('/'));

    if (!(await exists(webapp))) {
      throw new Error(`The draw.io archive has no ${WEBAPP}.`);
    }

    if (!(await exists(join(temporary, 'LICENSE')))) {
      throw new Error('The draw.io archive has no LICENSE.');
    }

    const files = {};

    for (const path of await filesUnder(webapp)) {
      files[path] = sha256(await readFile(join(webapp, ...path.split('/'))));
    }

    const manifest = { version: lock.version, files };
    const notice = join(temporary, 'NOTICE');

    await mkdir(out, { recursive: true });
    await rm(join(out, 'manifest.json'), { force: true });
    await rm(join(out, 'webapp'), { recursive: true, force: true });
    await rename(webapp, join(out, 'webapp'));
    await copyFile(join(temporary, 'LICENSE'), join(out, 'LICENSE'));
    await rm(join(out, 'NOTICE'), { force: true });

    if (await exists(notice)) {
      await copyFile(notice, join(out, 'NOTICE'));
    }

    await writeFile(
      join(out, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const main = async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const at = process.argv.indexOf('--out');

  if (at === -1 || process.argv[at + 1] === undefined) {
    throw new Error('Usage: node vendor.mjs --out <dir>');
  }

  const lock = JSON.parse(
    await readFile(join(here, 'drawio.lock.json'), 'utf8'),
  );
  const manifest = await vendor({
    lock,
    out: resolve(process.argv[at + 1]),
    cacheDir: resolve(
      here,
      '..',
      '..',
      '..',
      'node_modules',
      '.cache',
      'drawio',
    ),
    download: (url) => fetch(url),
  });

  console.log(
    `draw.io ${manifest.version}: ${Object.keys(manifest.files).length} files vendored.`,
  );
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
