// settings.models/v1 (bundle isolation 6(c)): everything the footer execution
// picker shows and every execution a pick yields. `settings` computes it from
// its configuration rules; the chat draws it and writes the Thread through
// `runtime.threads/v1`. Client and local, read only: nothing writes the
// default through this contract.

import {
  type CallArg,
  type Disposable,
  disposableSchema,
  functionSchema,
  noInput,
  ref,
} from 'bundle/contracts';
import type { ErrorInfo } from 'desktop/reads';
import type { ReasoningEffort } from 'runtime/contracts';
import { z } from 'zod';

import type { ModelExecution } from './configuration.js';

/** What a Thread record stores of its execution; a Thread created before `runtime.threads/v1` 1.7.0 stores none of it. */
export interface StoredExecution {
  readonly providerId?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface ModelChoice {
  readonly label: string;
  /** The choice's key, unique in the view. */
  readonly value: string;
  /** SVG markup of the model's icon, when it has one. */
  readonly icon?: string;
  /** What the Thread runs on when the reader picks this model. */
  readonly execution: ModelExecution;
}

export interface ModelGroup {
  /** The provider's label; absent when one provider holds every model. */
  readonly label?: string;
  readonly choices: readonly ModelChoice[];
}

export interface EffortChoice {
  readonly label: string;
  readonly value: ReasoningEffort;
  /** "(default)" on the effort the model's catalog names as its default. */
  readonly note?: string;
  /** What the Thread runs on when the reader picks this effort. */
  readonly execution: ModelExecution;
}

export type ExecutionView =
  | {
      /** No configuration was read yet. */
      readonly status: 'loading';
      /** The last read's failure, kept while a read that follows it runs. */
      readonly error?: ErrorInfo;
      readonly reloading: boolean;
    }
  | {
      readonly status: 'ready';
      /** A failed re-read; the view keeps the last configuration beside it. */
      readonly error?: ErrorInfo;
      readonly reloading: boolean;
      /** The execution shown: `stored` resolved against the configuration, or the default. */
      readonly execution: ModelExecution;
      /** The shown model's icon. */
      readonly icon?: string;
      /** The `value` of the shown model's choice. */
      readonly value: string;
      /** `false`: no provider lists a model, and the model is typed by hand. */
      readonly listsModels: boolean;
      readonly groups: readonly ModelGroup[];
      /** The efforts the shown model accepts, without `none`. */
      readonly efforts: readonly EffortChoice[];
      /** The shown effort's label; "Unavailable" when `efforts` is empty. */
      readonly effortLabel: string;
      /** The provider a model typed by hand is written on. */
      readonly typedProviderId: string;
    };

export interface SettingsModels {
  /**
   * The picker's data for one stored execution, or for the default execution
   * when `stored` is absent. Local. The same object for equal arguments until
   * the configuration, an icon or the read's state changes.
   */
  view(stored?: StoredExecution, call?: CallArg): ExecutionView;
  /** Called after every change of what `view` answers. Local. */
  subscribe(listener: () => void, call?: CallArg): Disposable;
  /** Reads the configuration again. Returns at once and never throws; a call while a read runs starts no second one. */
  reload(call?: CallArg): void;
}

export const SettingsModelsV1 = ref<SettingsModels>('settings.models/v1');

/**
 * An effort, typed by the runtime's `ReasoningEffort`. The provider checked
 * it against the settings' own list, so the schema names no third list.
 */
const effortSchema = z.custom<ReasoningEffort>(
  (value) => typeof value === 'string',
  { message: 'Expected a reasoning effort.' },
);

const executionSchema = z.strictObject({
  providerId: z.string(),
  model: z.string(),
  effort: effortSchema.optional(),
});

const storedSchema = z.object({
  providerId: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

/** `ErrorInfo` of `desktop/reads`, which declares no schema of its own. */
const errorInfoSchema = z.strictObject({
  code: z.string(),
  provider: z.string().optional(),
  status: z.number().optional(),
  message: z.string(),
  retryable: z.boolean().optional(),
  causes: z.array(
    z.strictObject({
      code: z.string().optional(),
      provider: z.string().optional(),
      status: z.number().optional(),
      retryable: z.boolean().optional(),
      message: z.string(),
    }),
  ),
  at: z.string().optional(),
});

const viewSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('loading'),
    error: errorInfoSchema.optional(),
    reloading: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('ready'),
    error: errorInfoSchema.optional(),
    reloading: z.boolean(),
    execution: executionSchema,
    icon: z.string().optional(),
    value: z.string(),
    listsModels: z.boolean(),
    groups: z.array(
      z.strictObject({
        label: z.string().optional(),
        choices: z.array(
          z.strictObject({
            label: z.string(),
            value: z.string(),
            icon: z.string().optional(),
            execution: executionSchema,
          }),
        ),
      }),
    ),
    efforts: z.array(
      z.strictObject({
        label: z.string(),
        value: effortSchema,
        note: z.string().optional(),
        execution: executionSchema,
      }),
    ),
    effortLabel: z.string(),
    typedProviderId: z.string(),
  }),
]);

/**
 * The zod schemas of the three methods. `view`'s input is the tuple form of an
 * optional argument; its output is strict, so a view carries no key its type
 * does not name. Descriptive only: the runtime forwards the original value.
 */
export const settingsModelsMethods = {
  view: {
    input: z.tuple([storedSchema.optional()]),
    output: viewSchema,
  },
  subscribe: {
    input: functionSchema<() => void>(),
    output: disposableSchema,
  },
  reload: { input: noInput, output: z.void() },
} as const;
