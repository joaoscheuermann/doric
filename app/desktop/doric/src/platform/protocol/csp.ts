// The content security policies of the desktop pages. The packaged and
// development policies are today's strings plus `worker-src 'self'` and the
// hash of the import map the shell carries; both also allow the screen
// bundle's loopback relay — `http://127.0.0.1:<ephemeral>` — as a frame, the
// only foreign origin a window embeds.

/** The packaged policy; the splash uses it without a hash in both modes. */
export const packagedCsp = (importMapHash?: string): string =>
  [
    "default-src 'none'",
    `script-src 'self'${importMapHash === undefined ? '' : ` 'sha256-${importMapHash}'`}`,
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "frame-src http://127.0.0.1:*",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

/** The development policy: today's string plus the import map hash. */
export const developmentCsp = (
  importMapHash: string,
  devServerOrigin: string,
): string =>
  `default-src 'self'; script-src 'self' 'unsafe-eval' 'sha256-${importMapHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${devServerOrigin.replace(/^http/, 'ws')}; frame-src http://127.0.0.1:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
