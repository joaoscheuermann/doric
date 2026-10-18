// The content security policies of the desktop pages. The packaged and
// development policies are today's strings plus `worker-src 'self'` and the
// hash of the import map the shell carries. Neither needs a `frame-src`
// exception any more: no window embeds a foreign origin, because the Project
// screen is a page the desktop opens in its own window, served by the host.
// Frames therefore fall back to the default source — `'none'` packaged, `'self'`
// in development — and nothing else is framed.

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
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

/** The development policy: today's string plus the import map hash. */
export const developmentCsp = (
  importMapHash: string,
  devServerOrigin: string,
): string =>
  `default-src 'self'; script-src 'self' 'unsafe-eval' 'sha256-${importMapHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${devServerOrigin.replace(/^http/, 'ws')}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
