// The Generative UI setting in the host (openui.md D24): `openui.setting/v1`
// over the `openui.generative-ui/v1` space, for windows, which cannot reach
// `settings/v1`.

import {
  type Call,
  defineMethod,
  defineService,
  type Services,
  SettingsV1,
  type StreamListener,
  toStreamObserver,
} from 'bundle/contracts';

import {
  type GenerativeUiSetting,
  generativeUiSetting,
  OpenuiSettingV1,
  openuiSettingMethods,
} from '../contracts/index.js';

const settingOf = (value: {
  readonly enabled: boolean;
}): GenerativeUiSetting => ({
  enabled: value.enabled,
});

/** Provides `openui.setting/v1`; every method is exposed to the desktop. */
export const settingService = () =>
  defineService(OpenuiSettingV1.id, {
    get: defineMethod({
      ...openuiSettingMethods.get,
      execute: async (
        _input: unknown,
        call: Call,
        services: Services,
      ): Promise<GenerativeUiSetting> =>
        settingOf(
          await services.use(SettingsV1).get(generativeUiSetting, call),
        ),
    }),
    set: defineMethod({
      ...openuiSettingMethods.set,
      execute: async (
        input: GenerativeUiSetting,
        call: Call,
        services: Services,
      ): Promise<GenerativeUiSetting> =>
        settingOf(
          (
            await services
              .use(SettingsV1)
              .set(generativeUiSetting, input, undefined, call)
          ).value,
        ),
    }),
    watch: defineMethod({
      ...openuiSettingMethods.watch,
      execute: (
        [listener]: [StreamListener<GenerativeUiSetting>],
        call: Call,
        services: Services,
      ) => {
        const observer = toStreamObserver(listener);
        const deliver = (value: GenerativeUiSetting): void => {
          const delivered: unknown = observer.next(value);
          // A remote listener answers a promise; its failure is the window's.
          if (delivered instanceof Promise) delivered.catch(() => undefined);
        };
        const settings = services.use(SettingsV1);
        let disposed = false;
        let written = false;
        const subscription = settings.subscribe(
          generativeUiSetting,
          (entry) => {
            written = true;
            deliver(settingOf(entry.value));
          },
        );
        void Promise.resolve()
          .then(() => settings.get(generativeUiSetting, call))
          .then(
            (value) => {
              if (!disposed && !written) deliver(settingOf(value));
            },
            () => undefined,
          );

        return {
          dispose: () => {
            disposed = true;
            subscription.dispose();
          },
        };
      },
    }),
  });
