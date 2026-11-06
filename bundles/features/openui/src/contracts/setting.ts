// The Generative UI setting (openui.md D24): the `openui.generative-ui/v1`
// space, global, off by default in 1.0.0 and on by default from 1.1.0
// (stage 3), and `openui.setting/v1`, through
// which windows read and write it (`settings/v1` does not cross the bridge).

import {
  type CallArg,
  type Disposable,
  defineSettings,
  disposableSchema,
  type MethodSpecs,
  noInput,
  ref,
  type StreamListener,
  streamListener,
} from 'bundle/contracts';
import { z } from 'zod';

/**
 * The `openui.generative-ui/v1` space (1.1.0). A space never written reads
 * `{ enabled: true }`; a stored value, including a `false` written under
 * 1.0.0, is read as stored and never replaced by the default.
 */
export const generativeUiSetting = defineSettings({
  id: 'openui.generative-ui/v1',
  schema: z.object({ enabled: z.boolean().default(true) }).strict(),
});

export interface GenerativeUiSetting {
  readonly enabled: boolean;
}

export const generativeUiSettingSchema = z
  .object({ enabled: z.boolean() })
  .strict() satisfies z.ZodType<GenerativeUiSetting, GenerativeUiSetting>;

/**
 * `openui.setting/v1` (host), every method exposed to the desktop, with no
 * scope: the space is global. Errors: `invalid_input` for a `set` input that
 * fails `generativeUiSettingSchema`; the errors of `settings/v1` otherwise.
 */
export interface OpenuiSetting {
  /** The stored value, or the default `{ enabled: true }`. */
  get(call?: CallArg): Promise<GenerativeUiSetting>;
  /** Writes the space with `settings/v1.set` and answers the stored value. */
  set(input: GenerativeUiSetting, call?: CallArg): Promise<GenerativeUiSetting>;
  /** The value on subscribe, then after every write, until disposed. */
  watch(
    listener: StreamListener<GenerativeUiSetting>,
    call?: CallArg,
  ): Disposable;
}

export const openuiSettingMethods = {
  get: { input: noInput, output: generativeUiSettingSchema, expose: 'desktop' },
  set: {
    input: generativeUiSettingSchema,
    output: generativeUiSettingSchema,
    expose: 'desktop',
  },
  // The listener is the last tuple item: that marks the call as a stream.
  watch: {
    input: z.tuple([streamListener(generativeUiSettingSchema)]),
    output: disposableSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

export const OpenuiSettingV1 = ref<OpenuiSetting>('openui.setting/v1');
