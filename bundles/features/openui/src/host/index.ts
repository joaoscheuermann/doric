// The `openui` bundle's host part (openui.md D17, D18, D24; conversation-openui.md
// D22): the `openui` skill, registered at activation, the error sink
// `openui.programs/v1` with its instruct at each prompt start, and the
// question service.

import { readFileSync } from 'node:fs';

import {
  type Cleanup,
  EventsV1,
  HooksV1,
  type HostContext,
  SkillsV1,
} from 'bundle/contracts';
import { RuntimeHooksV1 } from 'runtime/contracts';

import { answeredEvent } from '../contracts/index.js';
import { questionsService } from './questions.js';
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
  const validation = createValidation();
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

  // No setting governs the skill any more (D24, stage 4).
  const registered = services.use(SkillsV1).register(skill, skillOptions);

  return () => {
    registered.dispose();
    hooks.dispose();
  };
};
