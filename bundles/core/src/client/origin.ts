/**
 * Whether `url` is in the window's origin. Compared by scheme and host:
 * `doric://app` is not a special scheme, so `URL.origin` is the opaque
 * `"null"` for it and for every other non-special URL alike.
 */
export const sameOrigin = (url: URL): boolean =>
  url.protocol === window.location.protocol &&
  url.host === window.location.host;
