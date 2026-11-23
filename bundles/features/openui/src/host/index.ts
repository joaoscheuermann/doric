// The `openui` bundle's host part (openui.md D17, D18, D24; conversation-openui.md
// D22): the `openui` skill, registered at activation, the error sink
// `openui.programs/v1` with its `validation` instructs in the same turn (200 ms
// after a closed report) and at each prompt start, and the question service.

import {
  type Cleanup,
  EventsV1,
  HooksV1,
  type HostContext,
  SkillsV1,
} from 'bundle/contracts';
import { RuntimeHooksV1 } from 'runtime/contracts';

import { answeredEvent } from '../contracts/index.js';
import { kernelOpenuiPorts } from './ports.js';
import { questionsService } from './questions.js';
import {
  OPENUI_SKILL_OPTIONS,
  openuiSkillOf,
  readSkillBesideModule,
} from './skill.js';
import { createValidation } from './validation.js';

export const activate = ({ services }: HostContext): Cleanup => {
  // D17's `openui` skill; its body is the committed, generated text, read here, never at import.
  const skill = openuiSkillOf(readSkillBesideModule());
  const validation = createValidation(kernelOpenuiPorts(services).threads);
  services.provide(validation.service());
  services.provide(questionsService());
  services.use(EventsV1).register(answeredEvent);

  const hooks = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (registrar) => {
      const started = registrar.onPromptStartedHook((input, call) =>
        validation.promptStarted(input, call),
      );

      return () => {
        started.dispose();
      };
    });

  // No setting governs the skill any more (D24, stage 4).
  const registered = services
    .use(SkillsV1)
    .register(skill, OPENUI_SKILL_OPTIONS);

  return () => {
    registered.dispose();
    hooks.dispose();
    validation.dispose();
  };
};
