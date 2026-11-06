// The `openui` bundle's host part (openui.md D17, D18, D24; conversation-openui.md
// D22): the Generative UI setting and `openui.setting/v1`, the `openui` skill
// while the setting is on, the error sink `openui.programs/v1` with its
// instruct at each prompt start, and the question service.

import { readFileSync } from 'node:fs';

import {
  AppHooksV1,
  type Cleanup,
  ContractError,
  type Disposable,
  EventsV1,
  HooksV1,
  type HostContext,
  SettingsV1,
  SkillsV1,
} from 'bundle/contracts';
import { RuntimeHooksV1 } from 'runtime/contracts';
import { AskV1 } from 'threads/contracts';

import { answeredEvent, generativeUiSetting } from '../contracts/index.js';
import { questionsService } from './questions.js';
import { settingService } from './setting.js';
import { createValidation } from './validation.js';

/** D17's `openui` skill; its body is the committed, generated text. */
const skill = {
  name: 'openui',
  description:
    'Answers with UI the app draws while you write: OpenUI Lang programs in openui-lang fences, with forms, tables, charts and question forms for the reader. Load it before writing an openui-lang or papercraft fence, or before asking the reader to decide something.',
  allowedTools: [],
  body: readFileSync(
    new URL('./skills/openui.md', import.meta.url),
    'utf8',
  ).trim(),
} as const;

/** D17's options: listed in the index and loaded on demand. */
const skillOptions = { order: 3400, alwaysAvailable: false } as const;

export const activate = ({ services }: HostContext): Cleanup => {
  const settings = services.use(SettingsV1);
  settings.register(generativeUiSetting);

  const validation = createValidation();
  services.provide(settingService());
  services.provide(validation.service());
  services.provide(questionsService());
  services.use(EventsV1).register(answeredEvent);

  const hooks = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (registrar) => {
      const started = registrar.onPromptStartedHook((input, call) =>
        validation.promptStarted(services, input, call),
      );

      return () => {
        started.dispose();
      };
    });

  // The skill exists only while the setting is on (D24).
  let registered: Disposable | undefined;
  let stopped = false;
  const follow = (enabled: boolean): void => {
    if (stopped) return;
    if (enabled && registered === undefined) {
      registered = services.use(SkillsV1).register(skill, skillOptions);
    } else if (!enabled && registered !== undefined) {
      registered.dispose();
      registered = undefined;
    }
  };

  // While the setting is on, `threads`' `ask` is withheld (D24, C10); with
  // no active provider of `threads.ask/v1` nothing is held, and the next
  // value that is on tries again.
  let withheld: Disposable | undefined;
  const withhold = (enabled: boolean): void => {
    if (stopped) return;
    if (enabled && withheld === undefined) {
      try {
        withheld = services.use(AskV1).withholdTool();
      } catch (error) {
        if (!(error instanceof ContractError && error.code === 'unavailable')) {
          throw error;
        }
      }
    } else if (!enabled && withheld !== undefined) {
      withheld.dispose();
      withheld = undefined;
    }
  };

  let written = false;
  const subscription = settings.subscribe(generativeUiSetting, (entry) => {
    written = true;
    follow(entry.value.enabled);
    withhold(entry.value.enabled);
  });

  // Storage connects at host start, so the value is read again there.
  const hostStart = services
    .use(HooksV1)
    .use(AppHooksV1)
    .onHostStartHook(async () => {
      const { enabled } = await settings.get(generativeUiSetting);
      follow(enabled);
      withhold(enabled);
    });
  void Promise.resolve()
    .then(() => settings.get(generativeUiSetting))
    .then(
      (value) => {
        if (!written) follow(value.enabled);
      },
      () => undefined,
    );

  return () => {
    stopped = true;
    subscription.dispose();
    hostStart.dispose();
    registered?.dispose();
    registered = undefined;
    withheld?.dispose();
    withheld = undefined;
    hooks.dispose();
  };
};
