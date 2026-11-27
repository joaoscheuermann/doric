// `papercraft`'s host part (phase 3, S57): `papercraft.programs/v1` and the
// `runtime.hooks/v1` handlers served over the routed ports.

import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import {
  createHookHandlers,
  type HookHandlers,
  type HostContext,
} from 'bundle/host';
import {
  OnPromptStartedHookInputSchema,
  OnThreadCwdChangedHookInputSchema,
} from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import type { ProgramsService } from '../contracts/gen/doric/papercraft/programs/v1/programs_pb.js';
import {
  cwdChangedOf,
  exportInputOf,
  exportResponseOf,
  libraryInputOf,
  libraryResponseOf,
  promptStartedOf,
  readInputOf,
  readItemsOf,
} from './codec.js';
import { createLibraryOperations } from './library.js';
import { type NativePackages, nativeOf } from './native.js';
import { createProgramOperations, type ProgramOperations } from './programs.js';
import {
  registerCwdEvent,
  registerSkill,
  routedPapercraftPorts,
} from './routed.js';
import {
  jobRunnerOver,
  PAPERCRAFT_RUNNER_PATH,
  type RunnerScript,
  runnerScriptOf,
} from './sandbox.js';
import { PAPERCRAFT_SKILL_PATH, papercraftSkillOf } from './skill.js';

/** What a test may replace; `main.ts` passes nothing. */
export interface PapercraftHostOptions {
  /** Reads one asset (skill, runner); default `context.assets.read`. */
  readonly readAsset?: (path: string) => Promise<Uint8Array>;
  /** Default `nativeOf(context.assets.require)`. */
  readonly native?: NativePackages;
  /** The 5-minute hold's clock; default `Date.now`. */
  readonly now?: () => number;
}

export interface PapercraftHost {
  /**
   * `papercraft.programs/v1` over `createProgramOperations(ports.files, {runJob: jobRunnerOver(ports.lease, runner,
   * native), cwdAt: library.cwdAt, native})`:
   * - `Library`/`Export` → `libraryInputOf`/`exportInputOf`, the operation with `callOf(context)`, answered
   *   `libraryResponseOf`/`exportResponseOf`;
   * - `Read` → `readInputOf`, `moduleFiles(dir, call)` (a `not_found` before the first item), then `readItemsOf`; stops
   *   when the caller cancels.
   * Errors: §4; `unavailable` 'papercraft is not active.' before `activate` resolved.
   */
  readonly programs: ServiceImpl<typeof ProgramsService>;
  /** The hook table `main.ts` serves as `HookHandlerService`. */
  readonly hooks: HookHandlers;
  /**
   * In order, steps 1–3 rejecting `activate` on failure (the service then stays `unavailable`):
   * 1. `papercraftSkillOf(UTF-8 of await read(PAPERCRAFT_SKILL_PATH))`, `read = options.readAsset ?? context.assets.read`
   *    — before S62 the real `context.assets` rejects "not listed in host.assets";
   * 2. `registerCwdEvent(context)`;
   * 3. `hooks.register` of `OnPromptStartedHookInputSchema` → `library.promptStarted(promptStartedOf(input), call)` and
   *    `OnThreadCwdChangedHookInputSchema` → `library.cwdChanged(cwdChangedOf(input), call)`, served from here on;
   * 4. `registerSkill(context, skill)` (a refusal leaves the skill out);
   * 5. the service answers.
   * Makes no `files/v1`, `runtime.lease/v1` or `runtime.threads/v1` call and reads no runner. The runner is
   * `read(PAPERCRAFT_RUNNER_PATH)` at the first job, once per host, a failure cached as no runner (D5).
   */
  activate(
    context: Pick<HostContext, 'services' | 'registrations' | 'assets'>,
  ): Promise<void>;
  /** Nothing to stop: jobs in flight finish; no hook work starts after the process stops serving. */
  deactivate(): void;
}

/** Builds the part with no I/O; never throws. */
export const createPapercraftHost = (
  options: PapercraftHostOptions = {},
): PapercraftHost => {
  const hooks = createHookHandlers();
  let operations: ProgramOperations | undefined;

  const activated = (): ProgramOperations => {
    if (operations === undefined) {
      throw new ContractError('unavailable', 'papercraft is not active.');
    }

    return operations;
  };

  return {
    programs: {
      library: async (request, context) =>
        libraryResponseOf(
          await activated().library(libraryInputOf(request), callOf(context)),
        ),
      export: async (request, context) =>
        exportResponseOf(
          await activated().export(exportInputOf(request), callOf(context)),
        ),
      read: async function* (request, context) {
        const files = activated().moduleFiles(
          readInputOf(request).dir,
          callOf(context),
        );

        for await (const item of readItemsOf(files)) {
          if (context.signal.aborted) return;
          yield item;
        }
      },
    },
    hooks,
    activate: async (context) => {
      const ports = routedPapercraftPorts(context.services);
      const read =
        options.readAsset ?? ((path: string) => context.assets.read(path));
      const native =
        options.native ??
        nativeOf((specifier) => context.assets.require(specifier));
      let runner: Promise<RunnerScript | undefined> | undefined;
      // D5: read at the first job, once per host; a failure is cached as no runner.
      const runnerScript = () =>
        (runner ??= read(PAPERCRAFT_RUNNER_PATH).then(
          runnerScriptOf,
          () => undefined,
        ));
      // Concurrent `cwdAt` lookups for one (project, thread, turn) share one promise: over the
      // router each re-reads the event log, so without this a second call would reach
      // `libraryFor` after the first job started instead of joining it (D14).
      const lookups = new Map<string, Promise<string | undefined>>();
      // The programs and the library entry need each other: `cwdAt` reaches the entry at call time.
      const programs = createProgramOperations(ports.files, {
        runJob: jobRunnerOver(ports.lease, runnerScript, native),
        cwdAt: (scope, turnSequence) => {
          const key = JSON.stringify([
            scope.projectId,
            scope.threadId,
            turnSequence,
          ]);
          let lookup = lookups.get(key);

          if (lookup === undefined) {
            lookup = library
              .cwdAt(scope, turnSequence)
              .finally(() => lookups.delete(key));
            lookups.set(key, lookup);
          }

          return lookup;
        },
        native,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      const library = createLibraryOperations(ports, programs);

      const skill = papercraftSkillOf(
        new TextDecoder().decode(await read(PAPERCRAFT_SKILL_PATH)),
      );

      await registerCwdEvent(context);
      await hooks.register(
        context,
        OnPromptStartedHookInputSchema,
        (input, call) => library.promptStarted(promptStartedOf(input), call),
      );
      await hooks.register(
        context,
        OnThreadCwdChangedHookInputSchema,
        (input, call) => library.cwdChanged(cwdChangedOf(input), call),
      );
      await registerSkill(context, skill);
      operations = programs;
    },
    deactivate: () => {},
  };
};
