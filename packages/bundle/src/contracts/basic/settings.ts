import { z } from 'zod';

import type { CallArg } from '../call.js';
import type { Disposable } from '../context.js';
import { ref, type SettingsDefinition } from '../define.js';
import type { ContractId } from '../ids.js';
import {
  disposableSchema,
  functionSchema,
  type MethodSpecs,
  settingsDefinitionSchema,
} from './common.js';

// Error codes raised by settings/v1: `unknown_settings` (the definition is
// not registered), `settings_missing` (the space was never set and its schema
// rejects `{}`), `settings_conflict` (`expectedRevision` does not match) and
// `invalid_input` (the value fails the schema).

/** One settings space: its value, a revision for optimistic writes and its version. */
export interface SettingsEntry<T = unknown> {
  readonly value: T;
  /** Per space; it grows by one on every write. */
  readonly revision: number;
  /** The owner's contract version from `provides`. */
  readonly version: string;
  /** When the space was last written (ISO-8601, milliseconds, UTC). */
  readonly updatedAt: string;
  /** The global settings generation counter after that write. */
  readonly generation: number;
}

export interface SettingsSetOptions {
  readonly expectedRevision?: number;
}

export interface Settings {
  register(definition: SettingsDefinition): Disposable;
  get<S extends z.ZodType>(
    definition: SettingsDefinition<ContractId, S>,
    call?: CallArg,
  ): Promise<z.output<S>>;
  /** API mínima: the value with its revision, version and write time. */
  entry<S extends z.ZodType>(
    definition: SettingsDefinition<ContractId, S>,
    call?: CallArg,
  ): Promise<SettingsEntry<z.output<S>>>;
  set<S extends z.ZodType>(
    definition: SettingsDefinition<ContractId, S>,
    value: z.input<S>,
    options?: SettingsSetOptions,
    call?: CallArg,
  ): Promise<SettingsEntry<z.output<S>>>;
  /** Listeners run synchronously after the commit, before the write lock is released. */
  subscribe<S extends z.ZodType>(
    definition: SettingsDefinition<ContractId, S>,
    listener: (entry: SettingsEntry<z.output<S>>) => void,
  ): Disposable;
}

export const SettingsV1 = ref<Settings>('settings/v1');

export const settingsEntrySchema = z
  .object({
    value: z.unknown(),
    revision: z.number().int(),
    version: z.string(),
    updatedAt: z.string(),
    generation: z.number().int(),
  })
  .strict();

export const settingsMethods = {
  register: { input: settingsDefinitionSchema, output: disposableSchema },
  get: { input: settingsDefinitionSchema, output: z.unknown() },
  entry: { input: settingsDefinitionSchema, output: settingsEntrySchema },
  set: {
    input: z.tuple([
      settingsDefinitionSchema,
      z.unknown(),
      z.object({ expectedRevision: z.number().optional() }).strict().optional(),
    ]),
    output: settingsEntrySchema,
  },
  subscribe: {
    input: z.tuple([
      settingsDefinitionSchema,
      functionSchema<(entry: SettingsEntry) => void>(),
    ]),
    output: disposableSchema,
  },
} as const satisfies MethodSpecs;
