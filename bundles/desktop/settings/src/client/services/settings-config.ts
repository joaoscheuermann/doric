// settings.config/v1 (WP-10P, R-9.8): the settings window's one autosave
// draft, for a section another bundle draws (Versioning in 10G). The draft
// is `use-config.ts`'s: a change set here is debounced, flushed on a field
// blur and on the window's close exactly like a change the built-in sections
// make. Client and local: the methods hand functions and the live draft.

import {
  type CallArg,
  type Disposable,
  defineMethod,
  defineService,
  disposableSchema,
  functionSchema,
  noInput,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

import type { Configuration } from '../domain/config.js';

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

/** What the settings view publishes: its draft and the setter that owns it. */
export interface DraftOwner {
  readonly draft: ConfigurationDraft | undefined;
  readonly setDraft: (next: ConfigurationDraft) => void;
}

/**
 * The bridge between the view's React state and the contract. The view
 * publishes its draft after every render that changed it; a write lands in
 * the bridge at once, so two writes in a row compose.
 */
export const createConfigBridge = () => {
  let owner: DraftOwner | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('Doric: a settings.config listener failed:', error);
      }
    }
  };
  return {
    publish: (next: DraftOwner | undefined): void => {
      const changed = owner?.draft !== next?.draft;
      owner = next;
      if (changed) notify();
    },
    draft: (): ConfigurationDraft | undefined => owner?.draft,
    setDraft: (
      update: (draft: ConfigurationDraft) => ConfigurationDraft,
    ): void => {
      const current = owner;
      if (current?.draft === undefined) return;
      const next = update(current.draft);
      owner = { ...current, draft: next };
      current.setDraft(next);
      notify();
    },
    subscribe: (listener: () => void): Disposable => {
      listeners.add(listener);
      let active = true;
      return {
        dispose: () => {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        },
      };
    },
  };
};

export type ConfigBridge = ReturnType<typeof createConfigBridge>;

/** The window's bridge; the settings view publishes into it. */
export const configBridge: ConfigBridge = createConfigBridge();

export const createSettingsConfig = (bridge: ConfigBridge = configBridge) =>
  defineService(SettingsConfigV1, {
    draft: defineMethod({
      ...settingsConfigMethods.draft,
      execute: () => bridge.draft(),
    }),
    setDraft: defineMethod({
      ...settingsConfigMethods.setDraft,
      execute: (update: (draft: ConfigurationDraft) => ConfigurationDraft) =>
        bridge.setDraft(update),
    }),
    subscribe: defineMethod({
      ...settingsConfigMethods.subscribe,
      execute: (listener: () => void) => bridge.subscribe(listener),
    }),
  });
