// A host part's start step (phase 3, slice S45): an `onHostStartHook`
// handler of `doric.app.hooks/v1` that reports through `doric.startup/v1`.

import type { JsonObject } from '@bufbuild/protobuf';


import type { Call } from '../../contracts/call.js';
import { OnHostStartHookInputSchema } from '../../contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import { StartupService } from '../../contracts/gen/doric/platform/startup/v1/startup_pb.js';

import type { HostContext } from './context.js';
import {
  contractErrorOf,
  type HandlerRegistration,
  type HookHandlerOptions,
  type HookHandlers,
} from './handlers.js';

/** The startup record a start step writes (`doric.startup/v1`). */
export interface HostStartup {
  /**
   * `StartupService.Stage{name}`: a later failure of the start is reported
   * at this stage. Rejects with the call's `ContractError`.
   */
  stage(name: string): Promise<void>;
  /**
   * `StartupService.Log{level, message, fields}`, with `fields` defaulting to
   * `{}` and sent as a `Struct`. Rejects with the call's `ContractError`.
   */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: JsonObject,
  ): Promise<void>;
}

/**
 * Registers `step` as this instance's handler of `doric.app.hooks/v1`
 * `onHostStartHook` (a sequence hook):
 * `hooks.register(context, OnHostStartHookInputSchema, …, options)`.
 *
 * When the host's run reaches the handler, it awaits `step(startup, call)`:
 * - `startup` calls `context.services.use(StartupService)`;
 * - `call` is the run's call, and the startup calls are made inside the
 *   handler, so they inherit its scope, trace, deadline and signal.
 *
 * The step's rejection (a startup call's included) fails the handler, the
 * run and the host's start, with its `ContractError`, or `internal`.
 * Resolves and rejects as `HookHandlers.register`.
 */
export const onHostStart = (
  hooks: HookHandlers,
  context: Pick<HostContext, 'registrations' | 'services'>,
  step: (startup: HostStartup, call: Call) => Promise<void>,
  options?: HookHandlerOptions,
): Promise<HandlerRegistration> =>
  hooks.register(
    context,
    OnHostStartHookInputSchema,
    async (_input, call) => {
      const client = context.services.use(StartupService);
      const reported = async (request: Promise<unknown>): Promise<void> => {
        try {
          await request;
        } catch (error) {
          throw contractErrorOf(error);
        }
      };

      await step(
        {
          stage: (name) => reported(client.stage({ name })),
          log: (level, message, fields = {}) =>
            reported(client.log({ level, message, fields })),
        },
        call,
      );
    },
    options,
  );
