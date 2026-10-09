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

/** One settings space: its value, a revision for optimistic writes and its version. */
export interface SettingsEntry<T = unknown> {
  readonly value: T;
  readonly revision: number;
  readonly version: string;
}

export interface SettingsSetOptions {
  readonly expectedRevision?: number;
}

/** First provider in stage 2; shapes may be refined before a provider publishes. */
export interface Settings {
  register(definition: SettingsDefinition): Disposable;
  get<S extends z.ZodType>(
    definition: SettingsDefinition<ContractId, S>,
    call?: CallArg,
  ): Promise<z.output<S>>;
  set<S extends z.ZodType>(
    definition: SettingsDefinition<ContractId, S>,
    value: z.input<S>,
    options?: SettingsSetOptions,
    call?: CallArg,
  ): Promise<SettingsEntry<z.output<S>>>;
  subscribe<S extends z.ZodType>(
    definition: SettingsDefinition<ContractId, S>,
    listener: (entry: SettingsEntry<z.output<S>>) => void,
  ): Disposable;
}

export const SettingsV1 = ref<Settings>('settings/v1');

export const settingsEntrySchema = z
  .object({ value: z.unknown(), revision: z.number(), version: z.string() })
  .strict();

export const settingsMethods = {
  register: { input: settingsDefinitionSchema, output: disposableSchema },
  get: { input: settingsDefinitionSchema, output: z.unknown() },
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
