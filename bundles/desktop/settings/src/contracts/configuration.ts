/**
 * The types a configuration draft is made of, as the settings window reads and
 * writes them through `host-config/v1`. Types only: no rule of the settings
 * client lives here.
 */

import type { ReasoningEffort } from 'runtime/contracts';

/** The identifier a provider kind is known by. The host owns the set. */
export type ProviderKindId = string;

/**
 * One model a provider offers, with the reasoning efforts that model accepts.
 * The efforts are present exactly when the kind keeps `reasonings`; a kind that
 * keeps only `models` — a server that translates the effort itself — carries a
 * name alone.
 */
export type ProviderModel = {
  readonly name: string;
  readonly reasonings?: readonly string[];
  /**
   * The effort the catalog names as this model's own, absent when it names none.
   * It is what a model starts at when the execution profile switches to it.
   */
  readonly defaultEffort?: string;
  /**
   * Whether the catalog says this model's reasoning cannot be turned off. The
   * execution toggle is then pinned on rather than offering a choice it cannot
   * make.
   */
  readonly mandatory?: boolean;
};

/**
 * One provider the host may call. The kind decides which fields carry a value
 * and which lists it keeps; a `secret` field names an `API_TOKEN` credential
 * rather than carrying a secret, and a `number` field still arrives as a string.
 */
export type ProviderConfiguration = {
  readonly id: string;
  readonly kind: ProviderKindId;
  /** The values of the fields the kind declares, keyed by `ProviderField.key`. */
  readonly configuration: { readonly [key: string]: string };
  /** The models it offers; present exactly when the kind declares `models`. */
  readonly models?: readonly ProviderModel[];
};

/**
 * The context-compaction policy, mirrored: the host owns the ranges and reads a
 * stored one back unchanged. A draft that names none is the host's own default —
 * `enabled: true`, `pressurePercent: 80`, `tailMinMessages: 6`,
 * `summaryMaxChars: 6000`, `charBudget: 200000`.
 */
export type ContextCompactionConfig = {
  readonly enabled: boolean;
  readonly pressurePercent: number;
  readonly tailMinMessages: number;
  readonly summaryMaxChars: number;
  readonly charBudget: number;
};

/**
 * The person the agent's prompts speak for, as the host keeps it. Both fields
 * are optional, and a draft carries no `profile` at all rather than `{}`. An
 * absent `timezone` means the host's own time zone applies.
 */
export type Profile = {
  readonly name?: string;
  readonly timezone?: string;
};

/**
 * How the runtime archives Threads on its own, as `host-config/v1` 1.2.0 keeps
 * it. Each key is optional and an absent one means the host's default:
 * `agentThreads: true` (an agent thread moves to Archived about 30 s after its
 * work finishes) and `mainThreadsAfter: '7d'` (an inactive main thread moves
 * after seven days; `'never'` turns that off).
 */
export type AutoArchive = {
  readonly agentThreads?: boolean;
  readonly mainThreadsAfter?: '1d' | '7d' | '30d' | 'never';
};

/** The host configuration, as `host-config/v1` answers it and a save sends it. */
export type Configuration = {
  readonly providers: readonly ProviderConfiguration[];
  readonly models: {
    readonly execution: ModelExecution;
  };
  readonly execution: {
    readonly maxTurns: number;
    /** The most one tool result may carry into the model, in characters. */
    readonly maxToolResultChars?: number;
    /**
     * The context-compaction policy the host carries; absent is the host's own
     * default, so a draft need not name one.
     */
    readonly contextCompaction?: ContextCompactionConfig;
  };
  /**
   * Per-tool values, keyed by tool name and then by the tool's own field keys.
   * The host always populates it; it is optional so a hand-built draft need not.
   */
  readonly tools?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The `GIT` credential the agent's git commands commit as; absent for none. */
  readonly gitCredentialId?: string;
  /** The `API_TOKEN` credential GitHub authenticates with; absent for none. */
  readonly githubCredentialId?: string;
  /** Name and time zone for the agent's prompts; absent for neither. */
  readonly profile?: Profile;
  /** How Threads are archived on their own; absent means the defaults. */
  readonly threads?: { readonly autoArchive?: AutoArchive };
};

/**
 * A provider, a model and an optional effort: the input of
 * `runtime.threads/v1.setThreadExecution` without its `id`.
 */
export type ModelExecution = {
  readonly providerId: string;
  readonly model: string;
  /**
   * The effort the model accepts; absent when it accepts none. A model whose
   * catalog names no efforts cannot be told one, so no reasoning block is sent.
   */
  readonly effort?: ReasoningEffort;
};
