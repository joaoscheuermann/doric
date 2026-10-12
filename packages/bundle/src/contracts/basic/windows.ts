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

export const openWindowRequestSchema = z
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

export const openWindowResultSchema = z.void();

export type WindowAppearance = z.input<typeof windowAppearanceSchema>;

export type OpenWindowRequest = z.input<typeof openWindowRequestSchema>;

/** First provider in stage 8 (desktopMain). */
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
