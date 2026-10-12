import { z } from 'zod';

import { ref } from '../define.js';
import type { MethodSpecs } from './common.js';

// Verbatim `Menus` interface of menus-and-keybindings.md.

export type MenuWhen = { path?: string; focus?: string }; // path: active route pattern

export interface Menus {
  addItem(item: {
    id: string;
    location: string; // 'app/<menu>' or 'dock'
    command: string;
    label: string;
    when?: MenuWhen;
    order?: number;
  }): Promise<void>;
  addKeybinding(binding: {
    command: string;
    key: string;
    when?: MenuWhen;
  }): Promise<void>;
  setContext(entry: {
    key: 'path' | 'focus';
    value: string | null;
  }): Promise<void>;
}

export const MenusV1 = ref<Menus>('menus/v1');

export const menuWhenSchema = z
  .object({ path: z.string().optional(), focus: z.string().optional() })
  .strict();

export const menuItemSchema = z
  .object({
    id: z.string(),
    location: z.string(),
    command: z.string(),
    label: z.string(),
    when: menuWhenSchema.optional(),
    order: z.number().optional(),
  })
  .strict();

export type MenuItem = z.output<typeof menuItemSchema>;

export const keybindingSchema = z
  .object({
    command: z.string(),
    key: z.string(),
    when: menuWhenSchema.optional(),
  })
  .strict();

export type Keybinding = z.output<typeof keybindingSchema>;

export const menuContextSchema = z
  .object({
    key: z.enum(['path', 'focus']),
    value: z.union([z.string(), z.null()]),
  })
  .strict();

export const menusMethods = {
  addItem: { input: menuItemSchema, output: z.void(), expose: 'desktop' },
  addKeybinding: {
    input: keybindingSchema,
    output: z.void(),
    expose: 'desktop',
  },
  setContext: { input: menuContextSchema, output: z.void(), expose: 'desktop' },
} as const satisfies MethodSpecs;
