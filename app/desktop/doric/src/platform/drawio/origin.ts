// The draw.io editor origin (S1): main's `https:` handler answers
// `DRAWIO_ORIGIN` from the vendored webapp on disk and passes every other
// host through untouched, so the editor resolves nothing over the network.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DRAWIO_ORIGIN, type DrawioDescription } from 'bundle/contracts';

import { drawioCsp } from '../protocol/csp';
import { insideRoot, segmentsOf } from '../protocol/handler';
import { mimeOf } from '../protocol/mime';
import { describeDrawio } from './assets';

/** The host of `DRAWIO_ORIGIN`; derived from it, never written out. */
export const DRAWIO_HOST: string = new URL(DRAWIO_ORIGIN).host;

/** `https:` and host `DRAWIO_HOST`, any path. An unparsable URL is false; never throws. */
export const isDrawioOriginUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);

    return parsed.protocol === 'https:' && parsed.host === DRAWIO_HOST;
  } catch {
    return false;
  }
};

export interface DrawioOriginDeps {
  /** `Resources.drawioRoot`; files are served from `<root>/webapp/`. */
  readonly root: string;
  /** Answers a request whose host is not `DRAWIO_HOST`, unchanged. */
  readonly passThrough: (request: Request) => Promise<Response>;
  /** Defaults to `node:fs/promises` `readFile`. */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

export interface HandlerRegistry {
  handle(
    scheme: string,
    handler: (request: Request) => Promise<Response>,
  ): void;
}

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-cache',
} as const;

const plain = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', ...BASE_HEADERS },
  });

/** The file a path names under `<root>/webapp/`, or undefined outside it. */
const fileOf = (root: string, pathname: string): string | undefined => {
  const segments = segmentsOf(pathname.slice(1));

  return segments === undefined
    ? undefined
    : insideRoot(join(root, 'webapp'), segments);
};

/**
 * Never rejects for a request on DRAWIO_HOST.
 * - Another host: deps.passThrough(request), unchanged.
 * - Not GET/HEAD: 405.
 * - A path outside <root>/webapp/ (`..`, encoded or not), a missing file or a directory: 404.
 * - Otherwise 200 with content-type from mimeOf; HEAD has no body.
 * Every response on DRAWIO_HOST has X-Content-Type-Options: nosniff and Cache-Control: no-cache.
 * text/html responses also have Content-Security-Policy: drawioCsp.
 */
export const respondDrawio = async (
  request: Request,
  deps: DrawioOriginDeps,
): Promise<Response> => {
  if (!isDrawioOriginUrl(request.url)) {
    return deps.passThrough(request);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return plain(405, 'Method not allowed');
  }

  const path = fileOf(deps.root, new URL(request.url).pathname);

  if (path === undefined) {
    return plain(404, 'Not found');
  }

  let body: Uint8Array;

  try {
    body = await (deps.readFile ?? readFile)(path);
  } catch {
    return plain(404, 'Not found');
  }

  const type = mimeOf(path);

  return new Response(
    request.method === 'HEAD'
      ? null
      : (body as unknown as ConstructorParameters<typeof Response>[0]),
    {
      status: 200,
      headers: {
        'content-type': type,
        ...BASE_HEADERS,
        ...(type === 'text/html'
          ? { 'content-security-policy': drawioCsp }
          : {}),
      },
    },
  );
};

/** protocol.handle('https', …) with respondDrawio. Throws whatever handle throws. */
export const registerDrawioOrigin = (
  protocol: HandlerRegistry,
  deps: DrawioOriginDeps,
): void => {
  protocol.handle('https', (request) => respondDrawio(request, deps));
};

/**
 * Registers, then describes. If registration throws → { available: false, reason: 'handler-failed' }.
 * Otherwise describeDrawio(deps.root). Never rejects.
 */
export const startDrawioOrigin = (
  protocol: HandlerRegistry,
  deps: DrawioOriginDeps,
): Promise<DrawioDescription> => {
  try {
    registerDrawioOrigin(protocol, deps);
  } catch {
    return Promise.resolve({ available: false, reason: 'handler-failed' });
  }

  return describeDrawio(deps.root);
};
