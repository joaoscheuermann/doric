// `runtime`'s host part over the router (phase 3, slice S46a): its routed
// services and the steps that bind them to the instance. S46b adds
// `runtime.threads/v1` and the generation handover.

import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { OnHostStopHookInputSchema } from 'bundle/contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import { type HookHandlers, type HostContext, onHostStart } from 'bundle/host';
import { OnEventAppendedHookInputSchema } from 'core/contracts/gen/doric/core/event_hooks/v1/event_hooks_pb.js';

import type { AttachmentsService } from '../contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import type { LeaseService } from '../contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import type { ThreadsService } from '../contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import type { UsageService } from '../contracts/gen/doric/runtime/usage/v1/usage_pb.js';
import type { RuntimeService } from '../contracts/gen/doric/runtime/v2/runtime_pb.js';
import { onEventAppended } from './appends.js';
import type { ArchiveSchedule } from './domain/archiver.js';
import type { Bindings } from './domain/bindings.js';
import { createNotices } from './domain/notices.js';
import { createRuntimeCore, type RuntimeCore, runtimeStores } from './index.js';
import {
  type ExternalPorts,
  routedPorts,
  routedRegistrations,
  routedRuntimeHooks,
} from './routed.js';
import { routedAttachmentsService } from './rpc/attachments.js';
import { detached } from './rpc/errors.js';
import { installRoutedHandover } from './rpc/handover.js';
import { routedLeaseService } from './rpc/lease.js';
import { routedRuntimeService } from './rpc/runtime.js';
import { routedThreadsService } from './rpc/threads.js';
import { routedUsageService } from './rpc/usage.js';
import { createThreadSessions } from './sessions.js';

/**
 * Each routed service by name, for `main.ts`'s static list (S48). S46b adds
 * `threads`; S47 `lease`, `workspace`; S48 `session`.
 */
export interface RuntimeImplementations {
  readonly runtime: ServiceImpl<typeof RuntimeService>;
  readonly attachments: ServiceImpl<typeof AttachmentsService>;
  readonly usage: ServiceImpl<typeof UsageService>;
  /** `runtime.threads/v1`. */
  readonly threads: ServiceImpl<typeof ThreadsService>;
  /** `runtime.lease/v1` (S47a). */
  readonly lease: ServiceImpl<typeof LeaseService>;
}

export interface RuntimeServicesOptions {
  /** The ports S47/S48 own, built from the activated context (tests pass in-process fakes). */
  readonly external: (context: HostContext) => ExternalPorts;
  /** Test hooks, as `provideRuntime` takes them. */
  readonly bindings?: Bindings;
  readonly archiveSchedule?: ArchiveSchedule;
}

/** runtime's routed services and the steps that bind them to the instance. */
export interface RuntimeServices {
  /**
   * Built at load with no I/O.
   * - Before `activate` resolved, every RPC fails with `unavailable`.
   * - After `deactivate`, every RPC fails as the disposed domain does
   *   (`shutting_down` for mutations).
   * - Each RPC keeps today's method's semantics: the request is `decode`d
   *   and parsed with today's input schema (`runtimeMethods.<m>.input`, built
   *   as today's tuple where the kernel takes one), so `invalid_input` issues
   *   match 1.x.
   * - The domain is called with `callOf(context)`.
   * - The answer is `encode`d with `runtimeOneofs`.
   * - Failures pass through `routedError`.
   */
  readonly implementations: RuntimeImplementations;
  /**
   * From `BundleDefinition.activate`:
   * 1. `routedRegistrations(context)` (awaited; its refusal rejects).
   * 2. `routedRuntimeHooks(context)`; `defined` is not awaited, and a failure
   *    is logged at `warn`.
   * 3. `routedPorts`, `runtimeStores(storage, ports,
   *    notices.publisher.event)`, then `createRuntimeCore`.
   * 4. `hooks.register(context, OnEventAppendedHookInputSchema, ({stream,
   *    type}) => onEventAppended(threads)({stream, type}))`.
   * 5. `onHostStart(hooks, context, step)`. The step, under the run's call,
   *    does `stage('workspace_reconciliation')`, `log('info', 'Reconciling
   *    persisted projects and threads')`, `lifecycle.recover()`, then
   *    `log('info', 'Workspace reconciled', {interruptedThreads,
   *    interruptedProjects})`. A failure fails the start (sequence hook).
   * 6. `hooks.register(context, OnHostStopHookInputSchema, () =>
   *    lifecycle.dispose())`.
   * 7. `installRoutedHandover(context, lifecycle)` (S46b).
   * The RPCs are served once steps 1–3 are done. Steps 4–6 are awaited too;
   * a refusal rejects `activate`. Throws a `TypeError` on a second call.
   */
  activate(context: HostContext, hooks: HookHandlers): Promise<void>;
  /**
   * From `BundleDefinition.deactivate`: `lifecycle.dispose()` (idempotent),
   * then the core's cleanup. Never rejects.
   */
  deactivate(): Promise<void>;
}

/** Builds the routed services. No I/O; never throws. One per process; tests make one per router. */
export const createRuntimeServices = (
  options: RuntimeServicesOptions,
): RuntimeServices => {
  let activated = false;
  /** The core `activate` built; the RPCs are served once it is set. */
  let bound: RuntimeCore | undefined;
  /** The activated instance's log, for what `deactivate` cannot report. */
  let log: HostContext['log'] | undefined;
  /** Removes the generation handover's handlers (step 7). */
  let removeHandover: (() => void) | undefined;
  /** The Thread sessions `runtime.workspace/v1` opens (S47b); empty until then. */
  const sessions = createThreadSessions();
  const core = (): RuntimeCore => {
    if (bound === undefined)
      throw new ContractError('unavailable', 'runtime is not activated.');
    return bound;
  };

  return {
    implementations: {
      runtime: routedRuntimeService(core),
      attachments: routedAttachmentsService(core),
      usage: routedUsageService(core),
      threads: routedThreadsService(core),
      lease: routedLeaseService(core, sessions),
    },
    activate: async (context, hooks) => {
      if (activated) throw new TypeError('runtime is already activated.');
      activated = true;
      log = context.log;

      const { storage } = await routedRegistrations(context);
      const runtimeHooks = routedRuntimeHooks(context);
      runtimeHooks.defined.catch((error: unknown) => {
        context.log.warn('runtime.hooks/v1 could not be defined', {
          err: error,
        });
      });
      const ports = routedPorts(
        context,
        storage,
        runtimeHooks.hooks,
        options.external(context),
      );
      const notices = createNotices(ports.log);
      const stores = runtimeStores(storage, ports, notices.publisher.event);
      const runtime = createRuntimeCore({
        ...stores,
        ports,
        notices,
        ...(options.bindings === undefined
          ? {}
          : { bindings: options.bindings }),
        ...(options.archiveSchedule === undefined
          ? {}
          : { archiveSchedule: options.archiveSchedule }),
      });
      bound = runtime;

      // What other bundles append to a Thread's log through `events/v1` is
      // folded into the Thread the moment it is committed.
      const appended = onEventAppended(stores.threads);
      await hooks.register(
        context,
        OnEventAppendedHookInputSchema,
        async ({ stream, type }) => {
          await detached(() => appended({ stream, type }));
        },
      );
      await onHostStart(hooks, context, async (startup) => {
        await startup.stage('workspace_reconciliation');
        await startup.log('info', 'Reconciling persisted projects and threads');
        const { interruptedThreads, interruptedProjects } = await detached(() =>
          runtime.lifecycle.recover(),
        );
        await startup.log('info', 'Workspace reconciled', {
          interruptedThreads,
          interruptedProjects,
        });
      });
      await hooks.register(context, OnHostStopHookInputSchema, async () => {
        // Running prompts are suspended while their tool bundles are active.
        await detached(() => runtime.lifecycle.dispose());
      });
      removeHandover = installRoutedHandover(context, runtime.lifecycle);
    },
    deactivate: async () => {
      if (bound === undefined) return;
      removeHandover?.();
      removeHandover = undefined;
      try {
        await bound.lifecycle.dispose();
        await bound.service.dispose();
      } catch (error) {
        log?.warn('runtime could not be disposed', { err: error });
      }
    },
  };
};
