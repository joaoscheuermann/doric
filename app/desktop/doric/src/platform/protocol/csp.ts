// The content security policies of the desktop pages. The packaged and
// development shell policies are today's strings plus `worker-src 'self'`,
// the hash of the import map the shell carries and `frame-src` for the
// preview frame document (docs/architecture/bundles/papercraft/
// isolamento.md) and the draw.io editor origin: a shell may embed only
// `doric://app/frame/` and `DRAWIO_ORIGIN`. The splash frames nothing.

import { DRAWIO_ORIGIN } from 'bundle/contracts';

import { DORIC_ORIGIN } from './scheme';

/** What a shell may frame: the preview frame and the draw.io editor origin. */
const FRAME_SRC = `frame-src ${DORIC_ORIGIN}/frame/ ${DRAWIO_ORIGIN}/`;

const packaged = (importMapHash: string | undefined, frames: boolean): string =>
  [
    "default-src 'none'",
    `script-src 'self'${importMapHash === undefined ? '' : ` 'sha256-${importMapHash}'`}`,
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    ...(frames ? [FRAME_SRC] : []),
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

/** The packaged shell policy. */
export const packagedCsp = (importMapHash: string): string =>
  packaged(importMapHash, true);

/** The splash's policy in both modes: packaged, without a hash or frames. */
export const splashCsp = (): string => packaged(undefined, false);

/** The development shell policy: today's string plus the import map hash. */
export const developmentCsp = (
  importMapHash: string,
  devServerOrigin: string,
): string =>
  `default-src 'self'; script-src 'self' 'unsafe-eval' 'sha256-${importMapHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; ${FRAME_SRC}; connect-src 'self' ${devServerOrigin.replace(/^http/, 'ws')}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/**
 * The preview frame document's policy, the same in both modes. The frame's
 * origin is opaque, so `'self'` would match nothing: sources name
 * `doric://app`. Only the shell may embed it.
 */
export const frameCsp = (importMapHash: string): string =>
  [
    "default-src 'none'",
    `script-src ${DORIC_ORIGIN} 'sha256-${importMapHash}'`,
    `style-src ${DORIC_ORIGIN} 'unsafe-inline'`,
    `font-src ${DORIC_ORIGIN}`,
    `img-src ${DORIC_ORIGIN} data: blob:`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${DORIC_ORIGIN}`,
  ].join('; ');

/**
 * The policy of every HTML response from the editor origin. Only the shell
 * (`doric://app`) and the editor itself may embed it. Phase 0 may add only
 * `'unsafe-inline'` and `'unsafe-eval'` to `script-src`, and only when the
 * e2e violation log shows the editor needs them.
 */
export const drawioCsp: string = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  `frame-ancestors ${DORIC_ORIGIN} 'self'`,
].join('; ');
