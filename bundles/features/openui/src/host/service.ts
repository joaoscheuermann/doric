// `openui`'s host part (phase 3, S56): `openui.programs/v1`,
// `openui.questions/v1` and the `onPromptStartedHook` handler served over the
// routed ports.

import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import {
  createHookHandlers,
  type HookHandlers,
  type HostContext,
} from 'bundle/host';
import { OnPromptStartedHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import type { ProgramsService } from '../contracts/gen/doric/openui/programs/v1/programs_pb.js';
import type { QuestionsService } from '../contracts/gen/doric/openui/questions/v1/questions_pb.js';
import {
  programErrorsInputOf,
  promptStartedOf,
  questionAnswerInputOf,
  questionRefOf,
  questionStateMessageOf,
} from './codec.js';
import type { OpenuiPorts } from './ports.js';
import { createQuestions } from './questions.js';
import {
  registerAnsweredEvent,
  registerSkill,
  routedOpenuiPorts,
} from './routed.js';
import { OPENUI_SKILL_PATH, openuiSkillOf } from './skill.js';
import { createValidation, scopeOf } from './validation.js';

/** What a test may replace; `main.ts` passes nothing. */
export interface OpenuiHostOptions {
  /** Reads one asset; default `context.assets.read`. */
  readonly readAsset?: (path: string) => Promise<Uint8Array>;
}

export interface OpenuiHost {
  /**
   * `openui.programs/v1`: `ReportErrors` → `programErrorsInputOf`, then
   * `report(scope.threadId, input)`, answers `{}`. Errors: `invalid_input`
   * (protovalidate, then zod); `invalid_scope` without `projectId`/`threadId`
   * in the call scope; `unavailable` ('openui is not active.') before
   * `activate` resolved.
   */
  readonly programs: ServiceImpl<typeof ProgramsService>;
  /**
   * `openui.questions/v1`: `Status`/`Answer` →
   * `questionRefOf`/`questionAnswerInputOf`, then
   * `createQuestions().status|answer(routedOpenuiPorts, input,
   * callOf(context))`, answered as `{questionState:
   * questionStateMessageOf(state)}`. Errors: contracts §4; `unavailable`
   * before `activate` resolved.
   */
  readonly questions: ServiceImpl<typeof QuestionsService>;
  /** The hook table `main.ts` serves as `HookHandlerService`. */
  readonly hooks: HookHandlers;
  /**
   * In order, each failure rejecting `activate` (the services then stay
   * `unavailable`):
   * 1. `openuiSkillOf(UTF-8 of await (options.readAsset ??
   *    context.assets.read)(OPENUI_SKILL_PATH))` — before S62 the real
   *    `context.assets` rejects "not listed in host.assets";
   * 2. `registerAnsweredEvent(context)`;
   * 3. `hooks.register(context, OnPromptStartedHookInputSchema, (input, call)
   *    => validation.promptStarted(promptStartedOf(input), call))` — served
   *    from here on;
   * 4. `registerSkill(context, skill)`;
   * 5. the two services answer.
   * Makes no `runtime.threads/v1` call.
   */
  activate(
    context: Pick<HostContext, 'services' | 'registrations' | 'assets'>,
  ): Promise<void>;
  /** `validation.dispose()`: no instruct starts after it. */
  deactivate(): void;
}

/** Builds the part with no I/O; never throws. */
export const createOpenuiHost = (
  options: OpenuiHostOptions = {},
): OpenuiHost => {
  const hooks = createHookHandlers();
  const questions = createQuestions();
  let validation: ReturnType<typeof createValidation> | undefined;
  let active:
    | {
        readonly ports: OpenuiPorts;
        readonly validation: ReturnType<typeof createValidation>;
      }
    | undefined;

  const activated = () => {
    if (active === undefined) {
      throw new ContractError('unavailable', 'openui is not active.');
    }

    return active;
  };

  return {
    programs: {
      reportErrors: (request, context) =>
        Promise.resolve().then(() => {
          const { validation: registry } = activated();
          const input = programErrorsInputOf(request);

          registry.report(scopeOf(callOf(context)).threadId, input);

          return {};
        }),
    },
    questions: {
      status: async (request, context) => {
        const { ports } = activated();
        const state = await questions.status(
          ports,
          questionRefOf(request),
          callOf(context),
        );

        return { questionState: questionStateMessageOf(state) };
      },
      answer: async (request, context) => {
        const { ports } = activated();
        const state = await questions.answer(
          ports,
          questionAnswerInputOf(request),
          callOf(context),
        );

        return { questionState: questionStateMessageOf(state) };
      },
    },
    hooks,
    activate: async (context) => {
      const ports = routedOpenuiPorts(context.services);
      const registry = createValidation(ports.threads);
      const read =
        options.readAsset ?? ((path: string) => context.assets.read(path));

      validation = registry;

      const skill = openuiSkillOf(
        new TextDecoder().decode(await read(OPENUI_SKILL_PATH)),
      );

      await registerAnsweredEvent(context);
      await hooks.register(
        context,
        OnPromptStartedHookInputSchema,
        (input, call) => registry.promptStarted(promptStartedOf(input), call),
      );
      await registerSkill(context, skill);
      active = { ports, validation: registry };
    },
    deactivate: () => {
      validation?.dispose();
    },
  };
};
