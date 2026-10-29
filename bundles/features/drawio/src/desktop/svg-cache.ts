// `drawio.svg/v1`: the desktopMain cache of the pages the client drew and
// measured, and of each revision's first page. Under the bundle's
// `doric.cache/v1` directory:
//
//   <root>/svg/<artifactId>@<revision>/<sha256>/<encodeURIComponent(pageId)>.<theme>.svg
//   <root>/svg/<artifactId>@<revision>/<sha256>/<encodeURIComponent(pageId)>.<theme>.layout.json
//   <root>/svg/<artifactId>@<revision>/<sha256>/first-page.json   ({ "pageId": … }, any theme)
//
// `first-page.json` cannot collide with an entry file: those always carry a
// `.<theme>.svg` or `.<theme>.layout.json` suffix. The directory is read
// lazily, on the first call, because this activation is also recorded at
// build time, where the platform's `doric.*` services answer nothing (the
// `artifacts` desktop part's pattern). No eviction in v1.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  type AnyServiceDefinition,
  type Call,
  ContractError,
  DoricCacheV1,
  DoricDrawioV1,
  type DrawioDescription,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';

import {
  type DiagramSvgKey,
  type DiagramSvgLookup,
  type DiagramSvgPage,
  type DiagramSvgPut,
  type DiagramSvgRevision,
  DrawioSvgV1,
  diagramFirstPageSchema,
  diagramLayoutSchema,
  diagramSvgKeySchema,
  diagramSvgLookupSchema,
  diagramSvgPutSchema,
  drawioSvgMethods,
} from '../contracts/index.js';

/** Writes `text` to a temporary file beside `file`, then renames it over `file`. */
const writeWhole = async (file: string, text: string): Promise<void> => {
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** Whether `path` lies strictly below the directory `parent`. */
const isWithin = (parent: string, path: string): boolean => {
  const rest = relative(parent, path);

  return (
    rest !== '' &&
    rest !== '..' &&
    !rest.startsWith(`..${sep}`) &&
    !isAbsolute(rest)
  );
};

/** The file's text, or undefined when it cannot be read. */
const readText = (file: string): Promise<string | undefined> =>
  readFile(file, 'utf8').then(
    (text) => text,
    () => undefined,
  );

/** The JSON in `text`, or undefined when it is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The files of the cache under one root. It trusts nothing it reads: a file
 * that is missing, unreadable or off-schema reads as absent.
 */
export class DiagramSvgCache {
  readonly #root: string;

  /** `root` is an absolute directory; it need not exist until the first `put`. */
  constructor(root: string) {
    this.#root = resolve(root);
  }
  /**
   * The absolute paths of the key's SVG and layout files, both inside
   * `<root>/svg/<artifactId>@<revision>/<sha256>/`. `undefined` when the key
   * is off-schema (`diagramSvgKeySchema`) or a path would resolve outside
   * that directory. Pure; touches no file. (Unchanged.)
   */
  filesOf(
    key: DiagramSvgKey,
  ): { readonly svg: string; readonly layout: string } | undefined {
    const parsed = diagramSvgKeySchema.safeParse(key);

    if (!parsed.success) {
      return undefined;
    }

    const { artifactId, revision, sha256, pageId, theme } = parsed.data;
    const directory = join(
      this.#root,
      'svg',
      `${artifactId}@${revision}`,
      sha256,
    );
    const base = join(directory, `${encodeURIComponent(pageId)}.${theme}`);
    const files = { svg: `${base}.svg`, layout: `${base}.layout.json` };

    return isWithin(this.#root, directory) &&
      dirname(files.svg) === directory &&
      dirname(files.layout) === directory
      ? files
      : undefined;
  }
  /**
   * The absolute path of the revision's first-page pointer,
   * `<root>/svg/<artifactId>@<revision>/<sha256>/first-page.json`.
   * `undefined` when `artifactId`, `revision` or `sha256` is off
   * `diagramSvgKeySchema`'s rules, or the path would resolve outside that
   * directory. Pure; touches no file.
   */
  firstPageFileOf(revision: DiagramSvgRevision): string | undefined {
    const parsed = diagramSvgKeySchema
      .pick({ artifactId: true, revision: true, sha256: true })
      .safeParse({
        artifactId: revision.artifactId,
        revision: revision.revision,
        sha256: revision.sha256,
      });

    if (!parsed.success) {
      return undefined;
    }

    const directory = join(
      this.#root,
      'svg',
      `${parsed.data.artifactId}@${parsed.data.revision}`,
      parsed.data.sha256,
    );
    const file = join(directory, 'first-page.json');

    return isWithin(this.#root, directory) && dirname(file) === directory
      ? file
      : undefined;
  }
  /** The page id the revision's pointer names, or undefined when it cannot be read. */
  async #firstPageOf(
    revision: DiagramSvgRevision,
  ): Promise<string | undefined> {
    const file = this.firstPageFileOf(revision);
    const text = file === undefined ? undefined : await readText(file);
    const pointer =
      text === undefined
        ? undefined
        : diagramFirstPageSchema.safeParse(parseJson(text));

    return pointer?.success ? pointer.data.pageId : undefined;
  }
  /**
   * The stored entry and its page, or null. With `lookup.pageId`, that key's
   * entry. Without it, the pointer's `pageId` (the pointer read as JSON
   * against `diagramFirstPageSchema`), then that page's entry in
   * `lookup.theme`. Null when the lookup is off `diagramSvgLookupSchema`, the
   * pointer is missing, unreadable, not JSON or off-schema, or either entry
   * file is missing, unreadable, or (the layout) not JSON or off
   * `diagramLayoutSchema`. Never rejects for any of those; writes nothing.
   */
  async get(lookup: DiagramSvgLookup): Promise<DiagramSvgPage | null> {
    const parsed = diagramSvgLookupSchema.safeParse(lookup);

    if (!parsed.success) {
      return null;
    }

    const { artifactId, revision, sha256, theme } = parsed.data;
    const pageId =
      parsed.data.pageId ??
      (await this.#firstPageOf({ artifactId, revision, sha256 }));

    if (pageId === undefined) {
      return null;
    }

    const files = this.filesOf({
      artifactId,
      revision,
      sha256,
      pageId,
      theme,
    });

    if (files === undefined) {
      return null;
    }

    const [layoutText, svg] = await Promise.all([
      readText(files.layout),
      readText(files.svg),
    ]);

    if (layoutText === undefined || svg === undefined) {
      return null;
    }

    const layout = diagramLayoutSchema.safeParse(parseJson(layoutText));

    if (!layout.success) {
      return null;
    }

    return { svg, layout: layout.data, pageId };
  }
  /**
   * Writes the layout, then the SVG, then — with `first` — the pointer
   * `{ "pageId": input.pageId }`, each to a temporary file in the revision's
   * directory renamed over the target, so a reader sees the old file or the
   * new one, never a partial one, and no temporary file is left. Replaces an
   * earlier entry and an earlier pointer. Rejects with `invalid_input`,
   * writing nothing, when the input is off `diagramSvgPutSchema`; rejects
   * with the I/O error otherwise (the pointer is then not written if the
   * entry failed).
   */
  async put(input: DiagramSvgPut): Promise<void> {
    const parsed = diagramSvgPutSchema.safeParse(input);
    const files = parsed.success
      ? this.filesOf({
          artifactId: parsed.data.artifactId,
          revision: parsed.data.revision,
          sha256: parsed.data.sha256,
          pageId: parsed.data.pageId,
          theme: parsed.data.theme,
        })
      : undefined;

    if (!parsed.success || files === undefined) {
      throw new ContractError('invalid_input', 'Not a drawio.svg/v1 entry.', {
        ...(parsed.success ? {} : { issues: parsed.error.issues }),
      });
    }

    await mkdir(dirname(files.svg), { recursive: true });
    await writeWhole(files.layout, JSON.stringify(parsed.data.layout));
    await writeWhole(files.svg, parsed.data.svg);

    if (parsed.data.first) {
      await writeWhole(
        join(dirname(files.svg), 'first-page.json'),
        JSON.stringify({ pageId: parsed.data.pageId }),
      );
    }
  }
}

/** What `svgCacheService` reads from the platform; each defaults to the platform's own. (Unchanged.) */
export interface SvgCacheDeps {
  /**
   * The cache root, read once on the first `get` or `put`.
   * Default: `services.use(DoricCacheV1).directory(call)`.
   */
  directory?(services: Services, call: Call): Promise<string>;
  /**
   * The editor origin's state, read on every `status`.
   * Default: `services.use(DoricDrawioV1).describe(call)`.
   */
  describe?(services: Services, call: Call): Promise<DrawioDescription>;
}

/**
 * The `drawio.svg/v1` definition (`status`, `get`, `put`, each
 * `expose: 'desktop'`) over a `DiagramSvgCache` at the directory `deps`
 * resolves. Inputs are checked against `drawioSvgMethods` (`get` against
 * `diagramSvgLookupSchema`, `put` against `diagramSvgPutSchema`) before the
 * cache sees them. Building the definition calls nothing. (Signature unchanged.)
 */
export const svgCacheService = (
  deps: SvgCacheDeps = {},
): AnyServiceDefinition => {
  const directory =
    deps.directory ??
    ((services: Services, call: Call) =>
      services.use(DoricCacheV1).directory(call));
  const describe =
    deps.describe ??
    ((services: Services, call: Call) =>
      services.use(DoricDrawioV1).describe(call));
  let cache: Promise<DiagramSvgCache> | undefined;

  const cacheOf = (services: Services, call: Call) => {
    cache ??= directory(services, call).then(
      (root) => new DiagramSvgCache(root),
      (error: unknown) => {
        cache = undefined;
        throw error;
      },
    );

    return cache;
  };

  return defineService(DrawioSvgV1, {
    status: defineMethod({
      ...drawioSvgMethods.status,
      execute: (_input, call, services) => describe(services, call),
    }),
    get: defineMethod({
      ...drawioSvgMethods.get,
      execute: (input, call, services) =>
        cacheOf(services, call).then((svgs) => svgs.get(input)),
    }),
    put: defineMethod({
      ...drawioSvgMethods.put,
      execute: (input, call, services) =>
        cacheOf(services, call).then((svgs) => svgs.put(input)),
    }),
  });
};
