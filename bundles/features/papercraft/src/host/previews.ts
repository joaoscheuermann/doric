// The preview builder and reader (path A).
//
// `build` derives the self-contained markup of one Project source file: an
// `html` file that is already a document is kept as it is, a fragment is
// wrapped in a minimal document, and the resulting markup carries the source
// path as its origin stamp. It writes nothing and answers the built file list
// with its content hash.
//
// `read` resolves a stored revision back to `{ files, markup }` by reading the
// artifact record through `artifacts/v1` and re-deriving the markup from the
// source it names. Path B (an ESM module served from the app origin) and path C
// (a host `view` window) are out of scope, so a revision's payload is its
// derivation, not a served module.
//
// A `component` source is accepted by the schema but only its file text is
// read: without path B there is no component runtime to mount, so a component
// previews as its source text rendered in the document. This is the honest
// boundary of path A.

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

/** The sha256 of a built payload, as `git`'s object hashes are written. */
export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const isDocument = (value: string): boolean => {
  const head = value.trimStart().slice(0, 256).toLowerCase();

  return head.startsWith('<!doctype') || /<html[\s>]/.test(head);
};

const ROOT_TAG =
  /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*(\/?)>/;

const TAG_NAME = /^<([a-zA-Z][a-zA-Z0-9-]*)/;

/** The raw-text elements whose inner markup is text, not elements to stamp. */
const RAW_ELEMENTS = ['script', 'style'] as const;

/**
 * Stamps the first element of a derived markup with the origin it came from —
 * the whole `path:line` the comment anchor reads as its `source` form. Used
 * where the root is synthetic (a `component` preview's `<pre>`), so the line
 * names where the derived block begins, not where a tag sits.
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

/**
 * The 1-based line the `index` position of a content sits on.
 */
const lineCount = (value: string): number =>
  [...value].filter((char) => char === '\n').length;

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

    // The raw text of a `<script>`/`<style>` is not elements: carry it over
    // until the matching close, and never stamp inside it.
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
 * and the source text of a `component` is embedded as escaped text (path A
 * has no component runtime) with the component's own file-level stamp.
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
    return stampRoot(
      wrapFragment(
        `<pre data-papercraft-component>${escapeHtml(content)}</pre>`,
        path,
      ),
      `${path}:1`,
    );
  }

  return isDocument(content)
    ? stampSource(content, path)
    : wrapFragment(stampSource(content, path), path);
};

/** The built file list of one derived markup. */
export const builtFiles = (markup: string): PreviewBuild => ({
  files: [{ path: 'index.html', sha256: sha256(markup) }],
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

/** Builds one input against the files it reads; writes nothing. */
export const buildPreview = async (
  services: Services,
  call: Call,
  input: PreviewBuildInput,
): Promise<PreviewBuild> => {
  const content = await readSource(services, call, input.path);

  return builtFiles(deriveMarkup(input.source, input.path, content));
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

  // The revision's own bytes: the registry serves an entry's base64 while the
  // work copy still holds the file that hashes to the entry the event named.
  const stored = record.entries.find(
    (entry): entry is ArtifactReadEntry & { readonly base64: string } =>
      entry.base64 !== undefined,
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
