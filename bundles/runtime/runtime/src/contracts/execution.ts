import { type ReasoningEffort, reasoningEfforts } from './model.js';

/*
 * The per-Thread execution rules (runtime.threads/v1 1.7.0, executor/v1
 * 1.4.0): which provider, model and effort a Thread runs on, and whether the
 * configuration in force can serve it. Pure and browser-safe: the runtime,
 * the `default` executor and the settings client run the same rules on their
 * own configuration types, which this module reads structurally.
 */

/**
 * The parts of the configuration the rules read: host-config/v1's
 * `ConfigurationValue`, the runtime's `Configuration` and the settings
 * client's `Configuration` are all assignable. A provider *lists* models when
 * `models` has at least one entry; absent or empty means models typed by hand.
 */
export interface ExecutionConfiguration {
  readonly providers: readonly {
    readonly id: string;
    readonly models?: readonly {
      readonly name: string;
      readonly reasonings?: readonly string[];
      readonly defaultEffort?: string;
    }[];
  }[];
  readonly models: {
    /** The workspace default: what a new top-level Thread stores. */
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      readonly effort?: string;
    };
  };
}

/**
 * A provider, a model and an optional effort, as a Thread stores them. An
 * absent `effort` means no effort: no reasoning block is requested.
 */
export interface ThreadExecution {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: ReasoningEffort;
}

/** Why an execution is refused or unavailable, in the order they are checked. */
export const threadExecutionIssues = ['provider', 'model', 'effort'] as const;
export type ThreadExecutionIssue = (typeof threadExecutionIssues)[number];

/** What a Thread runs on under the configuration in force. */
export type ResolvedThreadExecution =
  | {
      readonly status: 'resolved';
      /** `thread`: the stored execution; `default`: a legacy Thread. */
      readonly source: 'thread' | 'default';
      readonly providerId: string;
      readonly model: string;
      /** Absent: no effort is requested. */
      readonly effort?: string;
    }
  | {
      /** The stored execution names a provider or model the configuration lacks. */
      readonly status: 'unavailable';
      readonly issue: 'provider' | 'model';
      readonly providerId: string;
      /** `''` when the Thread stores a provider but no model. */
      readonly model: string;
      readonly effort?: string;
    };

const isReasoningEffort = (value: string): value is ReasoningEffort =>
  (reasoningEfforts as readonly string[]).includes(value);

const providerOf = (
  configuration: ExecutionConfiguration,
  providerId: string,
) => configuration.providers.find((provider) => provider.id === providerId);

const modelEntry = (
  configuration: ExecutionConfiguration,
  providerId: string,
  model: string,
) =>
  providerOf(configuration, providerId)?.models?.find(
    (entry) => entry.name === model,
  );

/**
 * Resolves what `thread` runs on. Never throws and never reads `effort` for
 * availability.
 * - No `providerId` (a Thread created before 1.7.0): `resolved`, `source:
 *   'default'`, the default's provider with `thread.model ?? default.model`
 *   and `thread.effort ?? default.effort`; nothing is checked.
 * - `providerId` without `model`: `unavailable`, `issue: 'model'`, `model: ''`.
 * - A provider the configuration lacks, or a model a listing provider does
 *   not list: `unavailable` with that issue and the stored values.
 * - Otherwise `resolved`, `source: 'thread'`, the stored values; `effort` is
 *   omitted when the Thread stores none. The default's effort is never used.
 */
export const resolveThreadExecution = (
  thread: {
    readonly providerId?: string;
    readonly model?: string;
    readonly effort?: string;
  },
  configuration: ExecutionConfiguration,
): ResolvedThreadExecution => {
  const { providerId, model, effort } = thread;
  if (providerId === undefined) {
    const fallback = configuration.models.execution;
    const resolvedEffort = effort ?? fallback.effort;
    return {
      status: 'resolved',
      source: 'default',
      providerId: fallback.providerId,
      model: model ?? fallback.model,
      ...(resolvedEffort === undefined ? {} : { effort: resolvedEffort }),
    };
  }
  const stored = effort === undefined ? {} : { effort };
  if (model === undefined) {
    return {
      status: 'unavailable',
      issue: 'model',
      providerId,
      model: '',
      ...stored,
    };
  }
  const issue = checkThreadExecution(configuration, { providerId, model });
  if (issue === 'provider' || issue === 'model') {
    return { status: 'unavailable', issue, providerId, model, ...stored };
  }
  return { status: 'resolved', source: 'thread', providerId, model, ...stored };
};

/**
 * The efforts the model's entry lists that are `reasoningEfforts`, in the
 * entry's order; `[]` when it lists none, or the provider or model is not
 * listed. Never throws.
 */
export const modelEfforts = (
  configuration: ExecutionConfiguration,
  providerId: string,
  model: string,
): readonly ReasoningEffort[] =>
  (modelEntry(configuration, providerId, model)?.reasonings ?? []).filter(
    isReasoningEffort,
  );

/**
 * The entry's `defaultEffort` when it is one of `modelEfforts`; else
 * `undefined`. Never throws.
 */
export const modelDefaultEffort = (
  configuration: ExecutionConfiguration,
  providerId: string,
  model: string,
): ReasoningEffort | undefined => {
  const preferred = modelEntry(configuration, providerId, model)?.defaultEffort;
  return preferred !== undefined &&
    isReasoningEffort(preferred) &&
    modelEfforts(configuration, providerId, model).includes(preferred)
    ? preferred
    : undefined;
};

/**
 * The effort `model` starts at on `providerId` when it is chosen for an
 * existing Thread or named alone by a spawn: `undefined` when `modelEfforts`
 * is empty; else `modelDefaultEffort` when it is not `none`; else the first
 * effort that is not `none`; else the first. Never throws.
 */
export const modelStartEffort = (
  configuration: ExecutionConfiguration,
  providerId: string,
  model: string,
): ReasoningEffort | undefined => {
  const efforts = modelEfforts(configuration, providerId, model);
  if (efforts.length === 0) return undefined;
  const preferred = modelDefaultEffort(configuration, providerId, model);
  return preferred !== undefined && preferred !== 'none'
    ? preferred
    : (efforts.find((effort) => effort !== 'none') ?? efforts[0]);
};

/**
 * Runtime host only; not re-exported from the contracts index. The first
 * issue that refuses `execution` under `configuration`, else `undefined`:
 * - `provider`: no provider has the id;
 * - `model`: the provider lists models and none is named `model`;
 * - `effort`: `effort` is given, the model's entry exists and has
 *   `reasonings`, and `reasonings` does not include it. An empty
 *   `reasonings` refuses every effort.
 * On a provider that lists no models, any model and any effort pass. Never
 * throws.
 */
export const checkThreadExecution = (
  configuration: ExecutionConfiguration,
  execution: ThreadExecution,
): ThreadExecutionIssue | undefined => {
  const provider = providerOf(configuration, execution.providerId);
  if (provider === undefined) return 'provider';
  const models = provider.models ?? [];
  if (models.length === 0) return undefined;
  const entry = models.find((candidate) => candidate.name === execution.model);
  if (entry === undefined) return 'model';
  if (
    execution.effort !== undefined &&
    entry.reasonings !== undefined &&
    !entry.reasonings.includes(execution.effort)
  ) {
    return 'effort';
  }
  return undefined;
};
