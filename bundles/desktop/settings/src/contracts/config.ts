// settings.config/v1 (WP-10P, R-9.8): the settings window's one autosave
// draft, for a section another bundle draws (Versioning in 10G). The draft
// is the window's own: a change set here is debounced, flushed on a field
// blur and on the window's close exactly like a change the built-in sections
// make. Client and local: the methods hand functions and the live draft.

import {
  type CallArg,
  type Disposable,
  disposableSchema,
  functionSchema,
  noInput,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

import type { Configuration } from './configuration.js';

/** The draft of the host configuration the settings window edits. */
export type ConfigurationDraft = Configuration;

export interface SettingsConfig {
  /** The window's draft, once the host configuration loaded. */
  draft(call?: CallArg): ConfigurationDraft | undefined;
  /** Replaces the draft with `update(draft)`; ignored before it loaded. */
  setDraft(
    update: (draft: ConfigurationDraft) => ConfigurationDraft,
    call?: CallArg,
  ): void;
  /** Called after every change of the draft. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const SettingsConfigV1 = ref<SettingsConfig>('settings.config/v1');

const draftSchema = z.custom<ConfigurationDraft | undefined>(
  (value) =>
    value === undefined || (typeof value === 'object' && value !== null),
  { message: 'Expected a configuration draft or undefined.' },
);

export const settingsConfigMethods = {
  draft: { input: noInput, output: draftSchema },
  setDraft: {
    input: functionSchema<(draft: ConfigurationDraft) => ConfigurationDraft>(),
    output: z.void(),
  },
  subscribe: {
    input: functionSchema<() => void>(),
    output: disposableSchema,
  },
} as const;
