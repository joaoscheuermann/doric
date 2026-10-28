// The `doric://app` protocol handler (doric-protocol.md): technical assets
// under `/platform/`, `/bundles/`, `/schemas/` and `/artifacts/`, the preview
// frame document under `/frame/`, a 404 for any missing file under them, and
// the shell for every other path.
//
// A preview frame has an opaque origin, so every module, font and sheet it
// loads is a cross-origin CORS request: only what a frame needs answers
// `Access-Control-Allow-Origin: *` — `/frame/*`, `/platform/*`,
// `/artifacts/*` and `/bundles/<id>@<version>/client/frames/*`
// (docs/architecture/bundles/papercraft/isolamento.md). The rest of
// `/bundles/`, `/schemas/` and the shell stay same-origin only.

import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { splashCsp } from './csp';
import type { DevProxy } from './dev-proxy';
import { FRAME_BOOT_SCRIPT, type FrameDocument } from './frame';
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
  /** `/artifacts/<artifactId>@<revision>/<path>`: a verified revision entry. */
  | {
      readonly type: 'artifact';
      readonly id: string;
      readonly revision: number;
      readonly segments: readonly string[];
    }
  | { readonly type: 'schema'; readonly segments: readonly string[] }
  /** `/frame/index.html`: the preview frame document. */
  | { readonly type: 'frame-document' }
  /** `/frame/boot.js`: the frame's boot script. */
  | { readonly type: 'frame-boot' };

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

  if (pathname.startsWith('/frame/')) {
    const segments = segmentsOf(pathname.slice('/frame/'.length));

    if (segments?.length === 1 && segments[0] === 'index.html') {
      return { type: 'frame-document' };
    }

    if (segments?.length === 1 && segments[0] === 'boot.js') {
      return { type: 'frame-boot' };
    }

    return notFound;
  }

  for (const prefix of [
    '/platform/',
    '/bundles/',
    '/schemas/',
    '/artifacts/',
  ] as const) {
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

    if (prefix === '/artifacts/') {
      const [folder, ...rest] = segments as [string, ...string[]];
      const at = folder.lastIndexOf('@');

      if (at <= 0 || at === folder.length - 1 || rest.length === 0) {
        return notFound;
      }

      const revision = folder.slice(at + 1);

      if (!/^[1-9][0-9]*$/u.test(revision)) {
        return notFound;
      }

      return {
        type: 'artifact',
        id: folder.slice(0, at),
        revision: Number(revision),
        segments: rest,
      };
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

/**
 * The verified artifact revisions the protocol may serve under `/artifacts/`:
 * `userData/artifacts/<artifactId>@<revision>/<path>`, written by the
 * `artifacts` bundle's desktopMain part only after each file's SHA-256 is
 * confirmed. Any path that resolves outside this root is a 404.
 */
export interface ServedArtifacts {
  /** The cache root, `userData/artifacts/`. */
  readonly root: string;
}

export interface ProtocolDeps {
  readonly resources: Resources;
  readonly shell: ShellRenderer;
  /** The preview frame document (`/frame/index.html`). */
  readonly frame: FrameDocument;
  readonly bundles: ServedBundles;
  /** Verified artifact revisions (`/artifacts/<artifactId>@<revision>/…`). */
  readonly artifacts: ServedArtifacts;
  /** Unpackaged only. */
  readonly devProxy?: DevProxy;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

/** Whether a preview frame (an opaque origin) may load this route's files. */
const framesMayLoad = (decision: RouteDecision): boolean => {
  switch (decision.type) {
    case 'frame-document':
    case 'frame-boot':
    case 'platform':
    case 'artifact':
      return true;
    case 'bundle':
      return (
        decision.segments.length > 2 &&
        decision.segments[0] === 'client' &&
        decision.segments[1] === 'frames'
      );
    default:
      return false;
  }
};

const CORS = { 'access-control-allow-origin': '*' } as const;

const notFoundResponse = (): Response =>
  new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });

/**
 * Whether a request for an app path is a document's navigation, the one kind
 * the shell answers. A subresource (a font, an image, a script, a fetch) at a
 * path no route serves is a 404: answered with the shell's HTML, it would be
 * read as the font or image it asked for. Electron hands a custom scheme's
 * handler no `Sec-Fetch-Dest`, so the request's `Accept` decides, as the dev
 * server's history fallback does (`htmlAcceptHeaders`): a navigation accepts
 * HTML. A request that names neither is taken as a navigation.
 */
const navigates = (headers: Headers | undefined): boolean => {
  const destination = headers?.get('sec-fetch-dest');
  if (destination !== null && destination !== undefined) {
    return destination === 'document';
  }

  const accept = headers?.get('accept');
  if (accept === null || accept === undefined) return true;

  return /\b(?:text\/html|application\/xhtml\+xml)\b/iu.test(accept);
};

/** Answers one request; every failure is a 404, never the shell. */
export const respond = async (
  request: { readonly url: string; readonly headers?: Headers },
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
  const cors = framesMayLoad(decision) ? CORS : {};
  const serve = async (
    path: string | undefined,
    extra: Record<string, string> = {},
  ): Promise<Response> => {
    const headers = { ...cors, ...extra };

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
      if (!navigates(request.headers)) return notFoundResponse();

      const { html, csp } = await deps.shell.render();

      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-security-policy': csp,
        },
      });
    }
    case 'frame-document':
      return new Response(deps.frame.html, {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-security-policy': deps.frame.csp,
          ...cors,
        },
      });
    case 'frame-boot':
      return new Response(FRAME_BOOT_SCRIPT, {
        status: 200,
        headers: { 'content-type': 'text/javascript', ...cors },
      });
    case 'splash':
      return await serve(
        insideRoot(deps.resources.platformRoot, decision.segments),
        { 'content-security-policy': splashCsp() },
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
    case 'artifact':
      return await serve(
        insideRoot(
          join(deps.artifacts.root, `${decision.id}@${decision.revision}`),
          decision.segments,
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
