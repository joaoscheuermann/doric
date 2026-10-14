import { z } from 'zod';

import type { CallArg } from '../call.js';
import { ref } from '../define.js';
import type { MethodSpecs } from './common.js';

// Verbatim from windows.md, located in bundle/contracts per the decisions.

/** Visual intent described in window-appearance.md. */
export const windowAppearanceSchema = z
  .object({
    size: z
      .object({
        width: z.number(),
        height: z.number(),
        minWidth: z.number().optional(),
        minHeight: z.number().optional(),
      })
      .strict()
      .optional(),
    titleBar: z.enum(['native', 'integrated', 'none']).default('integrated'),
    background: z.string().default('window'), // token name, not a color
  })
  .strict();

/**
 * A window whose content is an app route: the shell the window loads renders
 * `doric://app/<path>` with the app's own preload and contracts.
 */
export const pathWindowRequestSchema = z
  .object({
    key: z.string(),
    path: z.string(),
    appearance: windowAppearanceSchema.optional(),
    /**
     * Marks the primary window: a core client that fails there is reported as
     * a core failure instead of ready. Main accepts one primary window at a
     * time and refuses a second one while the first is open.
     */
    primary: z.boolean().optional(),
  })
  .strict();

/**
 * 1.1.0: the content of a window that shows a page on the host, not in the app.
 *
 * The path is host-relative rather than an absolute URL: main is the one that
 * knows the origin the app reaches the host on (its `hostUrl`, which a
 * deployment points at a remote server or a reverse proxy), so a bundle never
 * needs to know it and cannot make main load an address of its own choosing —
 * only a path under the host it already talks to.
 */
export const windowViewSchema = z
  .object({
    /**
     * The host-relative path to load, starting with `/`, which main resolves
     * against the origin the app reaches the host on.
     */
    path: z.string().startsWith('/'),
    /** The Electron session partition of the view's `webContents`. */
    partition: z.string(),
    /** The window title; absent, the page's own title. */
    title: z.string().optional(),
  })
  .strict();

/**
 * 1.1.0: a window whose content is a page on the host. The view is the window's
 * own `webContents`: it draws no app chrome, hosts no preload and no bundle
 * contracts, and main owns its navigation. Its partition keeps the page's
 * cookies, storage and cache apart from the app's own session.
 */
export const viewWindowRequestSchema = z
  .object({
    key: z.string(),
    view: windowViewSchema,
    appearance: windowAppearanceSchema.optional(),
    /** The primary rule stated on `pathWindowRequestSchema` applies here too. */
    primary: z.boolean().optional(),
  })
  .strict();

/**
 * The window to open. 1.1.0 adds the second content kind: each shape is strict,
 * so they refuse each other's keys and a request names exactly one of them.
 */
export const openWindowRequestSchema = z.union([
  pathWindowRequestSchema,
  viewWindowRequestSchema,
]);

export const openWindowResultSchema = z.void();

export type WindowAppearance = z.input<typeof windowAppearanceSchema>;

export type PathWindowRequest = z.input<typeof pathWindowRequestSchema>;

export type WindowView = z.input<typeof windowViewSchema>;

export type ViewWindowRequest = z.input<typeof viewWindowRequestSchema>;

export type OpenWindowRequest = z.input<typeof openWindowRequestSchema>;

/**
 * A window a bundle asks the core to open: either an app route (`path`) or a
 * page on the host (a `view` with its own session partition), named one or the
 * other, never both.
 * First provider in stage 8 (desktopMain).
 */
export interface Windows {
  open(request: OpenWindowRequest, call?: CallArg): Promise<void>;
}

export const WindowsV1 = ref<Windows>('windows/v1');

export const windowsMethods = {
  open: {
    input: openWindowRequestSchema,
    output: openWindowResultSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;
