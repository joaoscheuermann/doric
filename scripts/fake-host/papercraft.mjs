// Dev-only: the papercraft build the fake host calls to materialise the seeded
// `preview` artifact.
//
// The build logic belongs to the `papercraft` bundle's host part
// (`bundles/features/papercraft/src/host/**`), never to the fake host: this
// module only finds the built module, picks the build it exports and adapts the
// call. When that module is absent the fake host says so and seeds no preview
// markup — there is deliberately no markup written here.
//
// The built host part is `bundles/features/papercraft/dist/host/index.js`
// (override: `DORIC_FAKE_PAPERCRAFT` / `--papercraft`), and it exports:
//
//  - `snapshotPreview(services, call, input)`, the build the bundle's tool and
//    kind run. A dev host runs no kernel, so this module hands it the one
//    service it reads — a `files/v1` over the workspace on disk — and keeps
//    every entry it answers with its bytes: the markup and, for a `component`,
//    the compiled `index.js` and `index.css` (path B);
//  - `deriveMarkup(source, path, content)` and `builtFiles(markup)`, the two
//    pure markup steps, used when an older host part has no `snapshotPreview`.
//    Either way the markup is the bundle's own derivation, and the file list
//    its own content hash — never a string written by the fake host.
//
// A host part that exports a single build function instead is called as
// `build({ dir, root, path, entry, source, artifactId, revision }, { dir, root, log })`
// and may answer `{ files, markup }` or the markup alone.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Export names tried in order for a single-function host part. */
const BUILD_EXPORTS = ['buildArtifact', 'previewBuild', 'build'];

/** A function whose name reads as a build: the last resort. */
const BUILD_NAME = /build.*(preview|artifact)|(preview|artifact).*build/i;

const isFunction = (value) => typeof value === 'function';

const pickBuild = (module) => {
  for (const name of BUILD_EXPORTS) {
    if (isFunction(module[name])) return { name, build: module[name] };
  }

  for (const [name, value] of Object.entries(module)) {
    if (isFunction(value) && BUILD_NAME.test(name))
      return { name, build: value };
  }

  return undefined;
};

const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

const sha256Of = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The `Services` `snapshotPreview` needs, over the workspace on disk: a
 * `files/v1` whose `content` reads a workspace-relative path, answering
 * `not_found` for a missing file and `invalid_path` for one outside it.
 */
const diskServices = (workspaceRoot) => ({
  use: () => ({
    content: async ({ path }) => {
      const root = resolve(workspaceRoot);
      const target = resolve(root, path);

      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        return { status: 'ready', value: { status: 'invalid_path' } };
      }

      const bytes = await readFile(target).catch(() => undefined);

      if (bytes === undefined) {
        return { status: 'ready', value: { status: 'not_found' } };
      }

      return {
        status: 'ready',
        value: {
          status: 'read',
          path,
          content: bytes.toString('utf8'),
          truncated: false,
          binary: bytes.includes(0),
        },
      };
    },
  }),
});

/**
 * Imports the papercraft host part and returns the build the fake host can
 * call, or `undefined` after saying why it could not be used.
 */
export const loadPapercraftBuild = async ({ root, override, log }) => {
  const path = resolve(
    override ?? join(root, 'bundles/features/papercraft/dist/host/index.js'),
  );

  if (!existsSync(path)) {
    log.note(
      `no papercraft host part at ${path}: the seeded preview artifact will be seeded without markup`,
    );

    return undefined;
  }

  let module;

  try {
    module = await import(pathToFileURL(path).href);
  } catch (error) {
    log.note(
      `the papercraft host part at ${path} could not be imported (${messageOf(error)}): the seeded preview artifact will be seeded without markup`,
    );

    return undefined;
  }

  // The real build: `snapshotPreview` over a `files/v1` that reads the
  // workspace from disk. It answers every entry of the revision — the
  // markup, and for a `component` the compiled `index.js`/`index.css` — with
  // the bytes that hash to each.
  if (isFunction(module.snapshotPreview)) {
    log.note(`papercraft build: snapshotPreview() from ${path}`);

    return {
      name: 'snapshotPreview',
      path,
      run: async ({ workspaceRoot, source, path: sourcePath, entry }) => {
        const built = await module.snapshotPreview(
          diskServices(workspaceRoot),
          { scope: {} },
          {
            source,
            path: sourcePath,
            ...(entry === undefined ? {} : { entry }),
          },
        );

        return {
          files: [...built.entries],
          markup: built.markup,
          bytes: Object.fromEntries(
            built.files.map((file) => [file.path, file.base64]),
          ),
        };
      },
    };
  }

  // The older path: the two pure steps `buildPreview` composes over the
  // source it reads through `files/v1`.
  if (isFunction(module.deriveMarkup)) {
    const files =
      isFunction(module.builtFiles) || isFunction(module.sha256)
        ? (markup) =>
            isFunction(module.builtFiles)
              ? module.builtFiles(markup).files
              : [{ path: 'index.html', sha256: module.sha256(markup) }]
        : undefined;

    log.note(`papercraft build: deriveMarkup() from ${path}`);

    return {
      name: 'deriveMarkup',
      path,
      run: ({ content, source, path: sourcePath }) => {
        const markup = module.deriveMarkup(source, sourcePath, content);

        return { files: files === undefined ? [] : files(markup), markup };
      },
    };
  }

  const picked = pickBuild(module);

  if (picked === undefined) {
    log.note(
      `the papercraft host part at ${path} exports neither deriveMarkup() nor a build function (looked for ${BUILD_EXPORTS.join(', ')}): the seeded preview artifact will be seeded without markup`,
    );

    return undefined;
  }

  log.note(`papercraft build: ${picked.name}() from ${path}`);

  return {
    name: picked.name,
    path,
    run: async (input) => {
      const result = await picked.build(
        {
          dir: input.dir,
          root: input.dir,
          path: input.path,
          entry: input.entry,
          source: input.source,
          artifactId: input.artifactId,
          revision: input.revision,
        },
        { dir: input.dir, root: input.dir, log: input.log },
      );

      if (typeof result === 'string') return { files: [], markup: result };

      return {
        files: Array.isArray(result?.files) ? result.files : [],
        markup: typeof result?.markup === 'string' ? result.markup : undefined,
      };
    },
  };
};

/**
 * The bytes of the payload: the Project-relative source path first (what the
 * records carry and `files/v1` would read), the artifact directory second (the
 * layout `docs/architecture/bundles/papercraft.md` shows for a payload the kind
 * writes itself).
 */
const payloadOf = async ({ workspaceRoot, dir, path }) => {
  const candidates = [
    join(workspaceRoot, path),
    join(dir, path),
    join(dir, basename(path)),
  ];

  for (const candidate of candidates) {
    const bytes = await readFile(candidate).catch(() => undefined);

    if (bytes !== undefined)
      return { path: candidate, content: bytes.toString('utf8') };
  }

  return undefined;
};

/**
 * Runs the papercraft build over one revision's payload and answers the entries
 * it produced plus the markup path A renders.
 */
export const buildPreview = async ({
  papercraft,
  workspaceRoot,
  dir,
  path,
  entry,
  source,
  artifactId,
  revision,
  log,
}) => {
  const payload = await payloadOf({ workspaceRoot, dir, path });

  if (payload === undefined) {
    log.note(
      `${papercraft.name}() found no payload for ${path} (looked under the workspace root and ${dir}): the revision has no preview markup`,
    );

    return { files: [], markup: undefined };
  }

  const built = await papercraft.run({
    workspaceRoot,
    dir,
    path,
    entry,
    source,
    artifactId,
    revision,
    content: payload.content,
    log,
  });

  if (built.markup !== undefined) return built;

  if (source === 'html') {
    // Path A of the docs, as the host part's own `deriveMarkup` states it: an
    // `html` source is the document. Only a host part that answered a file
    // list without markup reaches this.
    return { files: built.files, markup: payload.content };
  }

  log.note(
    `${papercraft.name}() answered no markup for a ${source ?? 'unknown'} source: the revision has its entries only`,
  );

  return { files: built.files, markup: undefined };
};

/** The content hash of a written payload; only for a kind that writes one. */
export const sha256 = sha256Of;
