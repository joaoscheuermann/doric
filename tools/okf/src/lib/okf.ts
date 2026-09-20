import { Buffer } from 'node:buffer';
import { posix as path } from 'node:path';

import * as YAML from 'yaml';
import { z } from 'zod';

import type { Sandbox } from 'sandbox';
import { defineTool } from 'tool';

import type { OkfToolOptions } from './types/okf.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_CONCEPTS = 10_000;
const MAX_QUERY_TERMS = 32;
const MAX_SEARCH_CHARS = 200_000;
const MAX_CONTENT_CHARS = 4_000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;
const RESERVED = new Set(['index.md', 'log.md']);

type YamlModule = {
  readonly parse?: (value: string, options?: object) => unknown;
  readonly default?: {
    readonly parse?: (value: string, options?: object) => unknown;
  };
};

const yaml = YAML as unknown as YamlModule;
const parseYaml = yaml.parse ?? yaml.default?.parse;
const description =
  'Search Open Knowledge Format concepts under .agents/bundles. Returns bounded, deterministically ranked concept metadata and Markdown content without reading outside the bundle root.';

export const input = z
  .object({
    query: z.string().trim().min(1).max(500),
    bundle: z.string().trim().min(1).max(255).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .strict();

const searchResult = z
  .object({
    bundle: z.string(),
    conceptId: z.string(),
    path: z.string(),
    type: z.string(),
    title: z.string(),
    description: z.string().optional(),
    resource: z.string().optional(),
    tags: z.array(z.string()),
    timestamp: z.string().optional(),
    content: z.string(),
    contentTruncated: z.boolean(),
    score: z.number(),
  })
  .strict();

export const output = z
  .object({
    results: z.array(searchResult),
    total: z.number(),
    truncated: z.boolean(),
    skipped: z.number(),
    error: z.string().optional(),
  })
  .strict();

export type OkfSearchResult = z.output<typeof searchResult>;

export type OkfSearchOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

type Options = OkfToolOptions & { readonly sandbox: Sandbox };

type Concept = Omit<OkfSearchResult, 'contentTruncated' | 'score'> & {
  readonly sourceTruncated: boolean;
};

type Ranked = {
  readonly concept: Concept;
  readonly score: number;
};

type LoadResult = { readonly concept: Concept } | { readonly skipped: true };

type PathKind = 'directory' | 'file' | 'missing' | 'other';

/** Creates the provider-neutral, read-only OKF bundle search tool. */
export const createTool = (options: OkfToolOptions) =>
  defineTool({
    name: 'okf_search',
    description,
    input,
    output,
    execute: (sandbox, input): Promise<OkfSearchOutput> =>
      execute({ ...options, sandbox }, input),
  });

const execute = async (
  options: Options,
  input: Input,
): Promise<OkfSearchOutput> => {
  const query = queryTerms(input.query);

  if ('error' in query) {
    return empty(query.error);
  }

  const root = normalizePath(
    path.join(options.workspaceRoot, '.agents/bundles'),
  );
  const target = searchTarget(root, input.bundle);

  if ('error' in target) {
    return empty(target.error);
  }

  const kind = await pathKind(options, target.path);

  if (kind !== 'directory') {
    return empty(missingMessage(input.bundle, kind));
  }

  const listed = await listConcepts(options, root, target.path);

  if ('error' in listed) {
    return empty(listed.error);
  }

  if (listed.paths.length > MAX_CONCEPTS) {
    return empty(
      `OKF search exceeds ${MAX_CONCEPTS} concepts; select a bundle.`,
    );
  }

  const loaded = await Promise.all(
    listed.paths.map((file) => loadConcept(options, root, file)),
  );

  const concepts = loaded.flatMap((result) =>
    'concept' in result ? [result.concept] : [],
  );
  const skipped = loaded.length - concepts.length;
  const ranked = rank(concepts, query.normalized, query.terms);

  return collect(ranked, skipped, input.limit ?? DEFAULT_LIMIT);
};

const searchTarget = (
  root: string,
  bundle: string | undefined,
): { readonly path: string } | { readonly error: string } => {
  if (bundle === undefined) {
    return { path: root };
  }

  const value = bundle.trim();

  if (
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    path.isAbsolute(value)
  ) {
    return { error: `Invalid bundle name: ${bundle}` };
  }

  const target = normalizePath(path.join(root, value));

  return contains(root, target)
    ? { path: target }
    : { error: `Invalid bundle name: ${bundle}` };
};

const missingMessage = (bundle: string | undefined, kind: PathKind): string => {
  if (bundle !== undefined) {
    return `OKF bundle not found: ${bundle}`;
  }

  if (kind === 'missing') {
    return 'OKF bundle root not found: .agents/bundles';
  }

  return 'OKF bundle root is not a directory: .agents/bundles';
};

const listConcepts = async (
  options: Options,
  bundleRoot: string,
  target: string,
): Promise<
  { readonly paths: readonly string[] } | { readonly error: string }
> => {
  const result = await options.sandbox.exec({
    cwd: options.workspaceRoot,
    cmd: ['find', target, '-type', 'f', '-name', '*.md', '-print'],
  });

  if (result.exitCode !== 0) {
    return { error: `Unable to list OKF concepts: ${result.stderr.trim()}` };
  }

  const paths = [...new Set(lines(result.stdout).map(normalizePath))]
    .filter((file) => isConceptPath(bundleRoot, file))
    .sort(compare);

  return { paths };
};

const isConceptPath = (bundleRoot: string, file: string): boolean => {
  if (!contains(bundleRoot, file) || RESERVED.has(path.basename(file))) {
    return false;
  }

  const parts = path.relative(bundleRoot, file).split('/');

  return parts.length >= 2 && file.endsWith('.md');
};

const loadConcept = async (
  options: Options,
  bundleRoot: string,
  file: string,
): Promise<LoadResult> => {
  const markdown = await options.sandbox.readFile(file).catch(() => undefined);

  if (markdown === undefined) {
    return { skipped: true };
  }

  const relative = path.relative(bundleRoot, file);
  const parts = relative.split('/');
  const metadata = frontmatter(markdown);
  const type = field(metadata?.value, 'type');

  if (metadata === undefined || type === undefined) {
    return { skipped: true };
  }

  const conceptId = parts.slice(1).join('/').slice(0, -3);
  const content = metadata.body.trim();
  const tags = stringArray(metadata.value.tags);

  return {
    concept: compact({
      bundle: parts[0] ?? '',
      conceptId,
      path: relative,
      type,
      title: field(metadata.value, 'title') ?? path.basename(conceptId),
      description: field(metadata.value, 'description'),
      resource: field(metadata.value, 'resource'),
      tags: [...tags],
      timestamp: field(metadata.value, 'timestamp'),
      content: content.slice(0, MAX_SEARCH_CHARS),
      sourceTruncated: content.length > MAX_SEARCH_CHARS,
    }),
  };
};

const frontmatter = (
  markdown: string,
):
  | { readonly value: Readonly<Record<string, unknown>>; readonly body: string }
  | undefined => {
  const match = FRONTMATTER.exec(markdown);

  if (match === null) {
    return undefined;
  }

  try {
    if (parseYaml === undefined) {
      return undefined;
    }

    const value = parseYaml(match[1] ?? '', { maxAliasCount: 50 });

    if (!isRecord(value)) {
      return undefined;
    }

    return { value, body: markdown.slice(match[0].length) };
  } catch {
    return undefined;
  }
};

const rank = (
  concepts: readonly Concept[],
  query: string,
  terms: readonly string[],
): readonly Ranked[] =>
  concepts
    .map((concept) => ({ concept, score: score(concept, query, terms) }))
    .filter((value) => value.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compare(left.concept.bundle, right.concept.bundle) ||
        compare(left.concept.conceptId, right.concept.conceptId),
    );

const score = (
  concept: Concept,
  query: string,
  terms: readonly string[],
): number => {
  const metadata = [
    [concept.title, 8],
    [concept.tags.join(' '), 7],
    [concept.description ?? '', 5],
    [concept.type, 4],
    [`${concept.conceptId} ${concept.resource ?? ''}`, 3],
  ] as const;

  const fields = metadata.map(
    ([value, weight]) => [normalize(value), weight] as const,
  );
  const body = normalize(concept.content);

  const termScore = terms.reduce((total, term) => {
    const metadataWeight = fields.find(([value]) => value.includes(term))?.[1];

    return total + (metadataWeight ?? (body.includes(term) ? 1 : 0));
  }, 0);

  const phraseScore = fields.some(([value]) => value.includes(query))
    ? 10
    : body.includes(query)
      ? 2
      : 0;

  return termScore + phraseScore;
};

const collect = (
  ranked: readonly Ranked[],
  skipped: number,
  requestedLimit: number,
): OkfSearchOutput => {
  const results: OkfSearchResult[] = [];
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);
  let bytes = 0;

  for (const value of ranked) {
    if (results.length >= limit) {
      break;
    }

    const result = present(value);
    const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');

    if (bytes + resultBytes > MAX_OUTPUT_BYTES) {
      break;
    }

    bytes += resultBytes;

    results.push(result);
  }

  return {
    results,
    total: ranked.length,
    truncated: results.length < ranked.length,
    skipped,
  };
};

const present = ({ concept, score }: Ranked): OkfSearchResult =>
  compact({
    bundle: concept.bundle,
    conceptId: concept.conceptId,
    path: concept.path,
    type: concept.type,
    title: concept.title,
    description: concept.description,
    resource: concept.resource,
    tags: concept.tags,
    timestamp: concept.timestamp,
    content: concept.content.slice(0, MAX_CONTENT_CHARS),
    contentTruncated:
      concept.sourceTruncated || concept.content.length > MAX_CONTENT_CHARS,
    score,
  });

const queryTerms = (
  value: string,
):
  | { readonly normalized: string; readonly terms: readonly string[] }
  | { readonly error: string } => {
  const normalized = normalize(value.trim());

  if (normalized === '' || normalized.length > 500) {
    return { error: 'Query must contain between 1 and 500 characters.' };
  }

  const terms = [
    ...new Set(
      normalized.match(/[\p{L}\p{N}](?:[\p{L}\p{N}_.:/-]*[\p{L}\p{N}])?/gu) ??
        [],
    ),
  ].slice(0, MAX_QUERY_TERMS);

  return terms.length === 0
    ? { error: 'Query must contain searchable letters or numbers.' }
    : { normalized, terms };
};

const pathKind = async (options: Options, value: string): Promise<PathKind> => {
  const result = await options.sandbox.exec({
    cwd: options.workspaceRoot,
    cmd: [
      'sh',
      '-c',
      'if [ -d "$1" ]; then printf directory; elif [ -f "$1" ]; then printf file; elif [ -e "$1" ]; then printf other; else printf missing; fi',
      'sh',
      value,
    ],
  });
  const valueKind = result.stdout.trim();

  return valueKind === 'directory' ||
    valueKind === 'file' ||
    valueKind === 'other'
    ? valueKind
    : 'missing';
};

const field = (
  value: Readonly<Record<string, unknown>> | undefined,
  name: string,
): string | undefined => {
  const raw = value?.[name];

  if (typeof raw !== 'string') {
    return undefined;
  }

  const text = raw.trim();

  return text === '' ? undefined : text;
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item !== 'string') {
          return [];
        }

        const text = item.trim();

        return text === '' ? [] : [text];
      })
    : [];

const compact = <Value extends Readonly<Record<string, unknown>>>(
  value: Value,
): Value =>
  Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as Value;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const empty = (error: string): OkfSearchOutput => ({
  results: [],
  total: 0,
  truncated: false,
  skipped: 0,
  error,
});

const normalize = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('en-US');

const normalizePath = (value: string): string => {
  const resolved = path.normalize(path.isAbsolute(value) ? value : `/${value}`);

  return resolved === '/' ? resolved : resolved.replace(/\/+$/u, '');
};

const contains = (root: string, child: string): boolean =>
  child === root || child.startsWith(`${root}/`);

const lines = (value: string): readonly string[] =>
  value.split(/\r?\n/u).filter((line) => line !== '');

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
