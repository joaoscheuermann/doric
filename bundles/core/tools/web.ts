import { z } from 'zod';

import { defineTool, type ToolFactory } from 'tool';

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const DEFAULT_FIND_LIMIT = 20;
const MAX_FIND_LIMIT = 100;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_PAGE_CHARS = 50_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const description =
  'Search the web, open HTTP(S) pages as extracted text, or find literal text in a page.';

export const input = z
  .object({
    action: z.enum(['search', 'open_page', 'find_in_page']),
    query: z.string().optional(),
    url: z.string().optional(),
    pattern: z.string().optional(),
    ignoreCase: z.boolean().optional(),
    limit: z.number().int().nonnegative().optional(),
    maxChars: z.number().int().nonnegative().optional(),
  })
  .strict();

const searchResult = z
  .object({ title: z.string(), url: z.string(), snippet: z.string() })
  .strict();

const page = z
  .object({ url: z.string(), title: z.string(), text: z.string() })
  .strict();
const findMatch = z.object({ line: z.number(), text: z.string() }).strict();

export const output = z
  .object({
    action: z.string(),
    detail: z.string(),
    results: z.array(searchResult),
    page: page.optional(),
    matches: z.array(findMatch),
    total: z.number(),
    truncated: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export type WebSearchResult = z.output<typeof searchResult>;

export type WebPageOutput = z.output<typeof page>;

export type WebFindMatch = z.output<typeof findMatch>;

export type WebOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  text(): Promise<string>;
};

type FetchLike = (
  url: string,
  init?: {
    readonly signal?: AbortSignal;
    readonly headers?: Record<string, string>;
  },
) => Promise<FetchResponse>;

type FetchTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

type Options = {
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs?: number;
};

/** Creates the provider-neutral web tool. */
export const createTool = (
  options: Options = {},
): ToolFactory<typeof input, typeof output> =>
  defineTool({
    name: 'web',
    description,
    input,
    output,
    execute: (_sandbox, input): Promise<WebOutput> =>
      execute(input, options.fetch ?? fetch, requestTimeout(options)),
  });

export default createTool();

const execute = async (
  input: Input,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<WebOutput> => {
  if (input.action === 'search') {
    return search(input, fetcher, timeoutMs);
  }

  if (input.action === 'open_page') {
    return openPage(input, fetcher, timeoutMs);
  }

  return findInPage(input, fetcher, timeoutMs);
};

const search = async (
  input: Input,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<WebOutput> => {
  const query = input.query?.trim();

  if (query === undefined || query === '') {
    return webError('search', 'Missing query for search');
  }

  const limit = clamp(input.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const url = new URL('https://duckduckgo.com/html/');

  url.searchParams.set('q', query);

  const html = await fetchText(url.toString(), fetcher, timeoutMs);

  if (!html.ok) {
    return webError('search', html.error);
  }

  const results = parseDuckDuckGoResults(html.text);
  const truncated = results.length > limit;

  return {
    action: 'search',
    detail: query,
    results: results.slice(0, limit),
    matches: [],
    total: results.length,
    truncated,
  };
};

const openPage = async (
  input: Input,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<WebOutput> => {
  const url = normalizedUrl(input.url);

  if (url === undefined) {
    return webError('open_page', 'Missing or invalid URL for open_page');
  }

  const maxChars = clamp(
    input.maxChars ?? DEFAULT_MAX_CHARS,
    1,
    MAX_PAGE_CHARS,
  );
  const html = await fetchText(url, fetcher, timeoutMs);

  if (!html.ok) {
    return webError('open_page', html.error);
  }

  const [text, truncated] = truncateText(extractPageText(html.text), maxChars);

  return {
    action: 'open_page',
    detail: url,
    results: [],
    page: {
      url,
      title: extractTitle(html.text),
      text,
    },
    matches: [],
    total: 1,
    truncated,
  };
};

const findInPage = async (
  input: Input,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<WebOutput> => {
  const url = normalizedUrl(input.url);

  if (url === undefined) {
    return webError('find_in_page', 'Missing or invalid URL for find_in_page');
  }

  const pattern = input.pattern?.trim();

  if (pattern === undefined || pattern === '') {
    return webError('find_in_page', 'Missing pattern for find_in_page');
  }

  const limit = clamp(input.limit ?? DEFAULT_FIND_LIMIT, 1, MAX_FIND_LIMIT);
  const html = await fetchText(url, fetcher, timeoutMs);

  if (!html.ok) {
    return webError('find_in_page', html.error);
  }

  const [matches, total, truncated] = findInText(
    extractPageText(html.text),
    pattern,
    input.ignoreCase ?? true,
    limit,
  );

  return {
    action: 'find_in_page',
    detail: `'${pattern}' in ${url}`,
    results: [],
    matches: [...matches],
    total,
    truncated,
  };
};

const fetchText = async (
  url: string,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<FetchTextResult> => {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return { ok: false, error: `Request returned HTTP ${response.status}` };
    }

    return { ok: true, text: await response.text() };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: `Request failed: timed out after ${timeoutMs}ms`,
      };
    }

    return {
      ok: false,
      error: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const parseDuckDuckGoResults = (html: string): readonly WebSearchResult[] => {
  const linkPattern =
    /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  const snippetPattern =
    /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>(.*?)<\/a>/gis;

  const snippets = [...html.matchAll(snippetPattern)].map((match) =>
    cleanHtml(match[1] ?? ''),
  );

  return [...html.matchAll(linkPattern)]
    .map((match, index) => ({
      title: cleanHtml(match[2] ?? ''),
      url: normalizeDuckDuckGoUrl(match[1] ?? ''),
      snippet: snippets[index] ?? '',
    }))
    .filter((result) => result.url !== '');
};

const normalizeDuckDuckGoUrl = (rawUrl: string): string => {
  const value = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;

  try {
    const url = new URL(value);

    return url.searchParams.get('uddg') ?? url.toString();
  } catch {
    return value;
  }
};

const normalizedUrl = (value: string | undefined): string | undefined => {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  try {
    const url = new URL(value.trim());

    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const extractTitle = (html: string): string => {
  const title = /<title[^>]*>(.*?)<\/title>/is.exec(html)?.[1] ?? '';

  return cleanHtml(title);
};

const extractPageText = (html: string): string => {
  const withoutHead = html.replace(/<head[^>]*>.*?<\/head>/gis, ' ');

  const withoutScripts = withoutHead.replace(
    /<script[^>]*>.*?<\/script>|<style[^>]*>.*?<\/style>|<noscript[^>]*>.*?<\/noscript>/gis,
    ' ',
  );

  const withBreaks = withoutScripts.replace(
    /<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?\s*>/gi,
    '\n',
  );
  const withoutTags = withBreaks.replace(/<[^>]+>/gis, ' ');
  const decoded = decodeHtml(withoutTags);

  const normalized = decoded
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/[ \t]{2,}/g, ' '))
    .filter((line) => line !== '')
    .join('\n');

  return normalized
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const findInText = (
  text: string,
  pattern: string,
  ignoreCase: boolean,
  limit: number,
): readonly [readonly WebFindMatch[], number, boolean] => {
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const matches: WebFindMatch[] = [];
  let total = 0;
  let truncated = false;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const haystack = ignoreCase ? line.toLowerCase() : line;

    if (!haystack.includes(needle)) {
      continue;
    }

    total += 1;

    if (matches.length >= limit) {
      truncated = true;

      break;
    }

    matches.push({ line: index + 1, text: line });
  }

  return [matches, total, truncated];
};

const truncateText = (
  text: string,
  maxChars: number,
): readonly [string, boolean] =>
  text.length <= maxChars ? [text, false] : [text.slice(0, maxChars), true];

const cleanHtml = (fragment: string): string =>
  decodeHtml(fragment.replace(/<[^>]+>/gis, ' '))
    .trim()
    .replace(/\s+/g, ' ');

const decodeHtml = (value: string): string =>
  value.replace(
    /&#(x[0-9a-fA-F]+|\d+);|&(amp|lt|gt|quot|apos|#39|nbsp);/g,
    (_, numeric: string | undefined, named: string | undefined) => {
      if (numeric !== undefined) {
        const code = numeric.toLowerCase().startsWith('x')
          ? Number.parseInt(numeric.slice(1), 16)
          : Number.parseInt(numeric, 10);

        return Number.isNaN(code) ? _ : String.fromCodePoint(code);
      }

      return (
        {
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
          '#39': "'",
          nbsp: ' ',
        }[named ?? ''] ?? _
      );
    },
  );

const webError = (action: string, error: string): WebOutput => ({
  action,
  detail: '',
  results: [],
  matches: [],
  total: 0,
  truncated: false,
  error,
});

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const requestTimeout = (options: Options): number =>
  Math.max(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 1);
