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
  open: { input: openWindowRequestSchema, output: openWindowResultSchema },
} as const satisfies MethodSpecs;
