// The one origin every desktop page loads from: `doric://app`.

export const DORIC_SCHEME = 'doric';
export const DORIC_ORIGIN_HOST = 'app';
export const DORIC_ORIGIN = `${DORIC_SCHEME}://${DORIC_ORIGIN_HOST}`;

/**
 * Whether a URL is of the `doric://app` origin. `URL.origin` is `'null'` for
 * a scheme Node does not know, so the protocol and host are compared [S8-1].
 */
export const isDoricAppUrl = (url: string | undefined): boolean => {
  if (url === undefined) {
    return false;
  }

  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === `${DORIC_SCHEME}:` &&
      parsed.host === DORIC_ORIGIN_HOST
    );
  } catch {
    return false;
  }
};

/** `doric://app` + a path that starts with `/`. */
export const doricUrl = (path: string): string => `${DORIC_ORIGIN}${path}`;
