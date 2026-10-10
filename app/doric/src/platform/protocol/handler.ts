// The `doric://app` protocol handler (doric-protocol.md): technical assets
// under `/platform/`, `/bundles/` and `/schemas/`, a 404 for any missing
// file under them, and the shell for every other path.

import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { packagedCsp } from './csp';
import type { DevProxy } from './dev-proxy';
import { mimeOf } from './mime';
import type { Resources } from './resources';
import { DORIC_ORIGIN_HOST, DORIC_SCHEME } from './scheme';
import type { ShellRenderer } from './shell';

export type RouteDecision =
  | { readonly type: 'not-found' }
  /** Any non-asset path: the per-request shell. */
  | { readonly type: 'shell' }
  /** `/platform/splash@<v>/index.html`. */
  | { readonly type: 'splash'; readonly segments: readonly string[] }
  /** `/platform/shell@<v>/…`: the renderer build (or the dev server). */
  | { readonly type: 'shell-asset'; readonly segments: readonly string[] }
  /** `/platform/<pkg>@<v>/…`. */
  | { readonly type: 'platform'; readonly segments: readonly string[] }
  | {
      readonly type: 'bundle';
      readonly id: string;
      readonly version: string;
      readonly segments: readonly string[];
    }
  | { readonly type: 'schema'; readonly segments: readonly string[] };

const notFound: RouteDecision = Object.freeze({ type: 'not-found' });

/**
 * Decoded path segments under a prefix; undefined when one is empty, `.`,
 * `..`, or carries NUL, a slash or a backslash once decoded.
 */
const segmentsOf = (path: string): string[] | undefined => {
  const raw = path.split('/');
  const decoded: string[] = [];

  for (const part of raw) {
    let segment: string;

    try {
      segment = decodeURIComponent(part);
    } catch {
      return undefined;
    }

    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\0') ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      return undefined;
    }

    decoded.push(segment);
  }

  return decoded;
};

/** Pure routing of one request URL (query and hash are ignored). */
export const route = (
  url: URL,
  versions: { readonly shell: string },
): RouteDecision => {
  if (url.protocol !== `${DORIC_SCHEME}:` || url.host !== DORIC_ORIGIN_HOST) {
    return notFound;
  }

  const { pathname } = url;

  for (const prefix of ['/platform/', '/bundles/', '/schemas/'] as const) {
    if (!pathname.startsWith(prefix)) {
      continue;
    }

    const segments = segmentsOf(pathname.slice(prefix.length));

    if (segments === undefined || segments.length === 0) {
      return notFound;
    }

    if (prefix === '/schemas/') {
      return { type: 'schema', segments };
    }

    if (prefix === '/bundles/') {
      const [folder, ...rest] = segments as [string, ...string[]];
      const at = folder.lastIndexOf('@');

      if (at <= 0 || at === folder.length - 1 || rest.length === 0) {
        return notFound;
      }

      return {
        type: 'bundle',
        id: folder.slice(0, at),
        version: folder.slice(at + 1),
        segments: rest,
      };
    }

    const [folder, ...rest] = segments as [string, ...string[]];

    if (folder === `shell@${versions.shell}`) {
      return rest.length === 0
        ? notFound
        : { type: 'shell-asset', segments: rest };
    }

    if (
      folder === `splash@${versions.shell}` &&
      rest.length === 1 &&
      rest[0] === 'index.html'
    ) {
      return { type: 'splash', segments };
    }

    return { type: 'platform', segments };
  }

  return { type: 'shell' };
};

/** `root` joined with the segments, or undefined when it leaves `root`. */
export const insideRoot = (
  root: string,
  segments: readonly string[],
): string | undefined => {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);

  return rel === '' || rel.startsWith('..') || rel.startsWith(sep)
    ? undefined
    : target;
};

/** The verified files the protocol may serve under `/bundles/`. */
export interface ServedBundles {
  /** The absolute path of a listed file of a retained generation, else undefined. */
  file(id: string, version: string, path: string): string | undefined;
}

export interface ProtocolDeps {
  readonly resources: Resources;
  readonly shell: ShellRenderer;
  readonly bundles: ServedBundles;
  /** Unpackaged only. */
  readonly devProxy?: DevProxy;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

const notFoundResponse = (): Response =>
  new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });

/** Answers one request; every failure is a 404, never the shell. */
export const respond = async (
  request: { readonly url: string },
  deps: ProtocolDeps,
): Promise<Response> => {
  let url: URL;

  try {
    url = new URL(request.url);
  } catch {
    return notFoundResponse();
  }

  const decision = route(url, { shell: deps.resources.shellVersion });
  const read = deps.readFile ?? ((path: string) => readFile(path));
  const serve = async (
    path: string | undefined,
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    if (path === undefined) {
      return notFoundResponse();
    }

    try {
      const body = await read(path);

      return new Response(
        body as unknown as ConstructorParameters<typeof Response>[0],
        {
          status: 200,
          headers: { 'content-type': mimeOf(path), ...headers },
        },
      );
    } catch {
      return notFoundResponse();
    }
  };

  switch (decision.type) {
    case 'not-found':
      return notFoundResponse();
    case 'shell': {
      const { html, csp } = await deps.shell.render();

      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-security-policy': csp,
        },
      });
    }
    case 'splash':
      return await serve(
        insideRoot(deps.resources.platformRoot, decision.segments),
        { 'content-security-policy': packagedCsp() },
      );
    case 'shell-asset':
      if (deps.devProxy !== undefined) {
        try {
          return await deps.devProxy.forward(url.pathname);
        } catch {
          return notFoundResponse();
        }
      }

      return await serve(
        insideRoot(deps.resources.shellRoot, decision.segments),
      );
    case 'platform':
      return await serve(
        insideRoot(deps.resources.platformRoot, decision.segments),
      );
    case 'schema':
      return await serve(
        insideRoot(deps.resources.schemasRoot, decision.segments),
      );
    case 'bundle':
      return await serve(
        deps.bundles.file(
          decision.id,
          decision.version,
          decision.segments.join('/'),
        ),
      );
  }
};

/** `protocol.handle('doric', …)` on the default session. */
export const registerDoricProtocol = (
  protocol: {
    handle(
      scheme: string,
      handler: (request: Request) => Promise<Response>,
    ): void;
  },
  deps: ProtocolDeps,
): void => {
  protocol.handle(DORIC_SCHEME, (request) => respond(request, deps));
};
