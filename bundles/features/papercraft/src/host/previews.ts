// The preview builder and reader.
//
// `build` derives one revision's files from one Project source:
//
// - `html` (path A): the self-contained markup — a document is kept as it is,
//   a fragment is wrapped in a minimal document — with every element stamped
//   with its origin (`data-papercraft-source="path:line"`). The revision's
//   only entry is `index.html`, which the node mounts directly.
// - `component` (path B): `compile.ts` bundles the source with esbuild (the
//   window's import-map specifiers external, Project files read through
//   `files/v1`) into `index.js`, an ESM module exporting
//   `mount(root, { theme })` that renders the chosen export with the
//   window's own React, and compiles its Tailwind into `index.css`. The
//   revision also keeps `index.html` — the source text in a `<pre>` — as the
//   path-A fallback the node shows when the module does not load. A source
//   that does not compile fails the build, before anything is published.
//
// It writes nothing: it answers each built file with its content hash, and the
// snapshot also hands over the bytes so the registry writes them into the work
// copy.
//
// `read` resolves a stored revision back to `{ files, markup }` by reading the
// artifact record through `artifacts/v1`: the `index.html` bytes the revision
// froze when the work copy still holds them, else a derivation from the
// source it names. Path C (a host `view` window) is out of scope.

import { createHash } from 'node:crypto';

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';

import {
  type ArtifactReadEntry,
  type ArtifactRevisionRead,
  ArtifactsV1,
  FilesV1,
  type PapercraftPreviews,
  PapercraftPreviewsV1,
  PREVIEW_KIND,
  type PreviewBuild,
  type PreviewBuildInput,
  type PreviewFile,
  type PreviewReadInput,
  type PreviewSource,
  type PreviewState,
  papercraftPreviewsMethods,
} from '../contracts/index.js';
import { compileComponent } from './compile.js';

/** The largest source file the builder reads. */
export const MAX_SOURCE_BYTES = 1_048_576;

const DEFAULT_STYLE = [
  ':root { color-scheme: light dark; }',
  'body { margin: 0; font: 14px/1.5 system-ui, sans-serif; padding: 16px; }',
].join('\n');

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The entry path of a revision's markup (path A, and B's fallback). */
export const MARKUP_ENTRY = 'index.html';

/** The entry path of a component revision's compiled module (path B). */
export const MODULE_ENTRY = 'index.js';

/** The entry path of a component revision's Tailwind sheet (path B). */
export const STYLES_ENTRY = 'index.css';

/** The sha256 of a built payload, as `git`'s object hashes are written. */
export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Leading whitespace and `<!-- … -->` comments, which may precede a doctype. */
const LEADING_TRIVIA = /^(?:\s+|<!--[\s\S]*?-->)*/;

/**
 * Whether a source is a whole document: its first markup, after whitespace
 * and comments of any length, is a doctype or the `<html>` element.
 */
const isDocument = (value: string): boolean => {
  const head = value.replace(LEADING_TRIVIA, '');

  return /^<!doctype[\s>]/i.test(head) || /^<html[\s>/]/i.test(head);
};

const ROOT_TAG =
  /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*(\/?)>/;

const TAG_NAME = /^<([a-zA-Z][a-zA-Z0-9-]*)/;

/**
 * The raw-text and escapable raw-text elements: their inner markup is text,
 * not elements to stamp (`<title>` and `<textarea>` show it verbatim).
 */
const RAW_ELEMENTS = ['script', 'style', 'title', 'textarea'] as const;

/**
 * Stamps the first element of a markup with the origin it came from — the
 * whole `path:line` the comment anchor reads as its `source` form. Used where
 * the element is synthetic (a `component` preview's `<pre>`), so the line names
 * where the derived block begins, not where a tag sits.
 */
export const stampRoot = (markup: string, origin: string): string => {
  if (markup.includes('data-papercraft-source=')) return markup;

  return markup.replace(
    ROOT_TAG,
    (_match, tag: string, attrs: string, selfClose: string) =>
      `<${tag}${attrs} data-papercraft-source="${escapeHtml(origin)}"${
        selfClose === '/' ? '/' : ''
      }>`,
  );
};

/**
 * Stamps one opening tag with `path:line`, when it does not already carry a
 * stamp: the origin the comment anchor's `source` form reads.
 */
const stampTag = (tag: string, path: string, line: number): string => {
  if (/data-papercraft-source\s*=/.test(tag)) return tag;

  const name = TAG_NAME.exec(tag)?.[1] ?? '';

  return tag.replace(
    TAG_NAME,
    `<${name} data-papercraft-source="${escapeHtml(`${path}:${String(line)}`)}"`,
  );
};

/** How many line breaks a chunk carries: the lines the scanner advances by. */
const lineCount = (value: string): number => {
  let count = 0;

  for (
    let at = value.indexOf('\n');
    at !== -1;
    at = value.indexOf('\n', at + 1)
  )
    count += 1;

  return count;
};

/**
 * Stamps every element of one source with the file and the line it came
 * from — `data-papercraft-source="path:line"` — as the docs' “anchors the
 * agent understands” ask: the build annotates each element, so a comment's
 * `source` anchor names the code that element is. Comments, doctypes and the
 * raw text of `<script>`/`<style>` are carried over untouched, and an element
 * that already carries a stamp keeps it.
 *
 * This is a scanner, not a parser: path A builds plain HTML sources, and it
 * stays honest about what it can attribute — every element the source itself
 * wrote gets the file's path and its own starting line.
 */
export const stampSource = (content: string, path: string): string => {
  const out: string[] = [];
  const total = content.length;
  let index = 0;
  let line = 1;

  const emit = (chunk: string): void => {
    out.push(chunk);
    line += lineCount(chunk);
  };

  while (index < total) {
    if (content[index] !== '<') {
      // Copy up to the next markup: text is never stamped.
      const next = content.indexOf('<', index);
      const stop = next === -1 ? total : next;

      emit(content.slice(index, stop));
      index = stop;
      continue;
    }

    if (content.startsWith('<!--', index)) {
      const end = content.indexOf('-->', index);
      const stop = end === -1 ? total : end + 3;

      emit(content.slice(index, stop));
      index = stop;
      continue;
    }

    const after = content[index + 1];

    if (after === '/' || after === '!' || after === '?') {
      // A closing tag, a doctype or a processing instruction: no stamp.
      const end = content.indexOf('>', index);
      const stop = end === -1 ? total : end + 1;

      emit(content.slice(index, stop));
      index = stop;
      continue;
    }

    if (after === undefined || /[a-zA-Z]/.test(after) === false) {
      emit('<');
      index += 1;
      continue;
    }

    // One opening tag: capture it whole, honoring quoted attribute values.
    let close = index + 1;
    let quote: string | undefined;

    while (close < total) {
      const char = content[close];

      if (quote !== undefined) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }

      close += 1;
    }

    const tag = content.slice(index, Math.min(close + 1, total));

    emit(stampTag(tag, path, line));
    index = close + 1;

    // The raw text of a raw-text element is not elements: carry it over until
    // the matching close, and never stamp inside it.
    const name = TAG_NAME.exec(tag)?.[1]?.toLowerCase() ?? '';
    const selfClosed = tag.trimEnd().endsWith('/>');

    if (!selfClosed && (RAW_ELEMENTS as readonly string[]).includes(name)) {
      const marker = `</${name}`;
      const remaining = content.slice(index);
      const upper = remaining.toUpperCase();
      const markerAt = upper.indexOf(marker.toUpperCase());

      if (markerAt === -1) {
        emit(remaining);
        index = total;
      } else {
        const stop = index + markerAt;

        emit(content.slice(index, stop));
        index = stop;
      }
    }
  }

  return out.join('');
};

const wrapFragment = (content: string, path: string): string =>
  `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(
    path,
  )}</title>\n<style>\n${DEFAULT_STYLE}\n</style>\n</head>\n<body>\n${content}\n</body>\n</html>\n`;

/**
 * The self-contained markup of one source: a document is stamped and kept, a
 * fragment has its elements stamped before the minimal document wraps them,
 * and the source text of a `component` is embedded as escaped text in a
 * `<pre>` that carries the component's own file-level stamp — the fallback
 * the node shows only when the revision's compiled module does not load.
 *
 * Every element the source itself wrote carries `data-papercraft-source="path:line"`,
 * so the comment anchor's `source` form names the code the element came from;
 * the wrapper a fragment derives is synthetic, so it carries no stamp.
 */
export const deriveMarkup = (
  source: PreviewSource,
  path: string,
  content: string,
): string => {
  if (source === 'component') {
    const origin = escapeHtml(`${path}:1`);

    return wrapFragment(
      `<pre data-papercraft-component data-papercraft-source="${origin}">${escapeHtml(
        content,
      )}</pre>`,
      path,
    );
  }

  return isDocument(content)
    ? stampSource(content, path)
    : wrapFragment(stampSource(content, path), path);
};

/** The built file list of one derived markup. */
export const builtFiles = (markup: string): PreviewBuild => ({
  files: [{ path: MARKUP_ENTRY, sha256: sha256(markup) }],
});

/**
 * Reads one Project source file as text through `files/v1`, refusing what a
 * preview cannot derive from: an unreadable sandbox, a missing file, or a
 * non-plain-text source. The kind's materialize provider reads its source the
 * same way.
 */
export const readSource = async (
  services: Services,
  call: Call,
  path: string,
): Promise<string> => {
  const content = await probeSource(services, call, path, true);

  if (content === undefined) {
    // Unreachable: a strict probe throws instead of answering nothing.
    throw new ContractError(
      'invalid_input',
      `The source "${path}" could not be read.`,
    );
  }

  return content;
};

/**
 * Reads one Project file as text, as `readSource` does, except that a file
 * that is not there answers `undefined` unless `strict`: the compiler probes
 * the candidates of an import this way.
 */
export const probeSource = async (
  services: Services,
  call: Call,
  path: string,
  strict = false,
): Promise<string | undefined> => {
  const outcome = await services
    .use(FilesV1, call.scope)
    .content({ path }, call);

  if (outcome.status !== 'ready') {
    throw new ContractError(
      'invalid_input',
      `The Project sandbox is not ready to read "${path}" (${outcome.status}).`,
      { path, status: outcome.status },
    );
  }

  const read = outcome.value;

  if (!strict && (read.status === 'not_found' || read.status === 'not_file')) {
    return undefined;
  }

  if (read.status !== 'read') {
    throw new ContractError(
      'invalid_input',
      `The source "${path}" could not be read (${read.status}).`,
      { path, status: read.status },
    );
  }

  if (read.truncated || read.binary) {
    throw new ContractError(
      'invalid_input',
      `The source "${path}" is not previewable plain text.`,
      { path, truncated: read.truncated, binary: read.binary },
    );
  }

  return read.content;
};

/** One revision's built payload: the markup, its entries and their bytes. */
export interface PreviewSnapshot {
  readonly markup: string;
  readonly entries: readonly PreviewFile[];
  readonly files: readonly { readonly path: string; readonly base64: string }[];
  /** What the build skipped without failing (a component's CSS imports). */
  readonly warnings: readonly string[];
}

/** One snapshot's input: the source kind, its path and a component's export. */
export interface PreviewSnapshotInput {
  readonly source: PreviewSource;
  readonly path: string;
  readonly entry?: string;
}

/**
 * One snapshot of a source: read once and built once, so the entries a
 * revision records and the bytes the registry writes come from the same read.
 * A `component` is compiled into `index.js` and `index.css` beside its
 * fallback `index.html`; a compile failure throws `invalid_input` naming the
 * errors.
 */
export const snapshotPreview = async (
  services: Services,
  call: Call,
  input: PreviewSnapshotInput,
): Promise<PreviewSnapshot> => {
  const content = await readSource(services, call, input.path);
  const markup = deriveMarkup(input.source, input.path, content);
  const built: { path: string; text: string }[] = [
    { path: MARKUP_ENTRY, text: markup },
  ];
  let warnings: readonly string[] = [];

  if (input.source === 'component') {
    const compiled = await compileComponent(
      (path) =>
        path === input.path
          ? Promise.resolve(content)
          : probeSource(services, call, path),
      {
        path: input.path,
        ...(input.entry === undefined ? {} : { entry: input.entry }),
      },
    );

    built.push(
      { path: MODULE_ENTRY, text: compiled.js },
      { path: STYLES_ENTRY, text: compiled.css },
    );
    warnings = compiled.warnings;
  }

  return {
    markup,
    entries: built.map(({ path, text }) => ({ path, sha256: sha256(text) })),
    files: built.map(({ path, text }) => ({
      path,
      base64: Buffer.from(text, 'utf8').toString('base64'),
    })),
    warnings,
  };
};

/** Builds one input against the files it reads; writes nothing. */
export const buildPreview = async (
  services: Services,
  call: Call,
  input: PreviewBuildInput,
): Promise<PreviewBuild> => {
  const { entries } = await snapshotPreview(services, call, {
    source: input.source,
    path: input.path,
    ...(input.entry === undefined ? {} : { entry: input.entry }),
  });

  return { files: [...entries] };
};

/**
 * The entries of one revision as the state names them: the identity the
 * revision recorded, without the bytes a read may have served.
 */
const recordedFiles = (record: ArtifactRevisionRead): PreviewFile[] =>
  record.entries.map(({ path, sha256 }) => ({ path, sha256 }));

/**
 * Resolves the preview state of a stored artifact revision. A revision is
 * immutable (the registry's own contract), so `read` serves the markup the
 * revision froze — the built files the registry wrote into the work copy when
 * the revision was created, which it hands back as the entry's bytes. Only a
 * revision without stored bytes falls back to deriving from the source it
 * names, and the answer says so with `derived` — that is a reading of the live
 * source, not of the revision.
 */
export const readPreview = async (
  services: Services,
  call: Call,
  input: PreviewReadInput,
): Promise<PreviewState | undefined> => {
  const record: ArtifactRevisionRead | undefined = await services
    .use(ArtifactsV1, call.scope)
    .read({ artifactId: input.artifactId, revision: input.revision }, call);

  if (record === undefined || record.kind !== PREVIEW_KIND) return undefined;

  // The revision's own markup: the registry serves an entry's base64 while
  // the work copy still holds the file that hashes to the entry the event
  // named. A component revision also stores its module and sheet; the markup
  // is always `index.html`.
  const stored = record.entries.find(
    (entry): entry is ArtifactReadEntry & { readonly base64: string } =>
      entry.path === MARKUP_ENTRY && entry.base64 !== undefined,
  );

  if (stored !== undefined) {
    const markup = Buffer.from(stored.base64, 'base64').toString('utf8');

    return {
      artifactId: record.artifactId,
      revision: input.revision,
      kind: 'preview',
      // The revision's own reading: the identity it recorded, and the bytes
      // the registry verified against that identity.
      files: recordedFiles(record),
      markup,
    };
  }

  const path = record.path;
  if (path === undefined || path === '') return undefined;

  const content = await readSource(services, call, path);
  const markup = deriveMarkup(record.source ?? 'html', path, content);

  return {
    artifactId: record.artifactId,
    revision: input.revision,
    kind: 'preview',
    // A derived reading names itself: its files are the derivation's, not
    // the identity a revision recorded without bytes.
    files: builtFiles(markup).files,
    markup,
    derived: true,
  };
};

/** `papercraft.previews/v1` over the host's files and artifacts services. */
export const papercraftPreviewsService = defineService(PapercraftPreviewsV1, {
  build: defineMethod({
    ...papercraftPreviewsMethods.build,
    execute: (
      input: PreviewBuildInput,
      call: Call,
      services: Services,
    ): Promise<PreviewBuild> => buildPreview(services, call, input),
  }),
  read: defineMethod({
    ...papercraftPreviewsMethods.read,
    execute: (
      input: PreviewReadInput,
      call: Call,
      services: Services,
    ): Promise<PreviewState | undefined> => readPreview(services, call, input),
  }),
});

export type { PapercraftPreviews };
