// The view window's content rules, without Electron: how a host-relative path
// becomes the URL the view loads, which navigations that view may make, and
// what `doric.windows/v1.navigate` does for a key (1.1.0).

import type { WindowKind } from './registry';

/**
 * The URL a view window loads: its host-relative path resolved against the
 * origin the app reaches the host on (`hostUrl`). A bundle names a path, never
 * an address, so main alone decides the origin — a deployment points `hostUrl`
 * at a remote server or a reverse proxy without any bundle knowing it.
 */
export const composeViewUrl = (hostUrl: string, path: string): string =>
  new URL(path, hostUrl).toString();

/** The origin a view window's page belongs to. */
export const viewOriginOf = (hostUrl: string, path: string): string =>
  new URL(composeViewUrl(hostUrl, path)).origin;

/**
 * A view may navigate inside its own origin — the xpra HTML5 client redirects
 * itself to `connect.html` on the same origin — and nothing else is honoured:
 * a navigation to another origin is refused. A URL that does not parse is
 * refused too.
 */
export const viewNavigationAllowed = (
  target: string,
  origin: string,
): boolean => {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
};

/**
 * What `doric.windows/v1.navigate` should do for a key: load a new host path in
 * a view window, refuse because the key names a path window, or report that no
 * window has that key.
 */
export type NavigateDisposition =
  | { readonly kind: 'view'; readonly url: string }
  | { readonly kind: 'path_window' }
  | { readonly kind: 'absent' };

/**
 * The `navigate` decision, pure: a view window follows the new host-relative
 * path resolved against the app's host origin, a path window is not navigable
 * this way, and an unknown key has no window.
 */
export const navigateDisposition = (
  entry: { readonly kind: WindowKind } | undefined,
  hostUrl: string,
  path: string,
): NavigateDisposition => {
  if (entry === undefined) {
    return { kind: 'absent' };
  }

  if (entry.kind !== 'view') {
    return { kind: 'path_window' };
  }

  return { kind: 'view', url: composeViewUrl(hostUrl, path) };
};
