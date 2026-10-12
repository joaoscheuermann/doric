import {
  AppHooksV1,
  type Disposable,
  DoricStartupV1,
  HooksV1,
  type Log,
  type Services,
} from 'bundle/contracts';

import type { Handover, RecoverySummary } from '../contracts/runtime.js';
import type { WorkspaceService } from './domain/types.js';
import type { ProjectStore, ThreadStore } from './store/types.js';

/*
 * The runtime's own lifecycle (design 57 §4.2, M3): the boot recovery, the
 * handover between generation processes, the drain of a replaced generation
 * and the host stop. The host kernel no longer calls these; the runtime's
 * start and stop hooks and its generation hooks (handover.ts) do. The
 * `runtime/v1` methods of the same names call them too, for one version.
 */

export interface RuntimeLifecycle {
  /** Once per runtime process: reconcile, resume and schedule the Projects. */
  recover(): Promise<RecoverySummary>;
  /** `recover` while other runtime processes are alive: standby for theirs. */
  recoverWith(handover: Handover): Promise<RecoverySummary>;
  /** Takes up the standby Projects that are no longer owned by a live process. */
  adopt(handover: Handover): Promise<void>;
  /** Lets every Project go; `released` is called once per Project. */
  drain(released: (projectId: string) => void): Promise<void>;
  /** Host stop: idempotent. */
  dispose(): Promise<void>;
}

export const createLifecycle = ({
  service,
  threads,
  projects,
  log,
}: {
  readonly service: WorkspaceService;
  readonly threads: ThreadStore;
  readonly projects: ProjectStore;
  readonly log: Log;
}): RuntimeLifecycle => {
  let recovery: Promise<RecoverySummary> | undefined;
  let disposal: Promise<void> | undefined;
  /** Adoptions run one at a time, after the recovery. */
  let adoptions: Promise<void> = Promise.resolve();

  /**
   * Today's boot sequence (agents/doric index.ts), once per runtime process.
   * The Projects a live process in the handover owns are left out (57-WP-H).
   */
  const reconcile = async (handover?: Handover): Promise<RecoverySummary> => {
    const include = await service.handover.begin(handover?.live ?? []);
    const interruptedThreads = await threads.reconcile(include);
    const interruptedProjects = await projects.reconcile(include);
    log.info('Project and thread reconciliation complete', {
      interruptedThreads,
      interruptedProjects,
    });
    // Work the reader asked for and a host interruption left unfinished is
    // work this boot owes them, so every such prompt is taken up before the
    // host starts serving new ones.
    const resumedPrompts = await service.resumeInterrupted(include);
    log.info('Interrupted prompts resumed', { resumedPrompts });
    await service.recoverProjects(include);
    log.info('Project sandbox recovery scheduled');
    return { interruptedThreads, interruptedProjects, resumedPrompts };
  };

  return {
    recover: () => {
      // A second call answers the first summary without doing the work again.
      recovery ??= reconcile();
      return recovery;
    },
    recoverWith: (handover) => {
      recovery ??= reconcile(handover);
      return recovery;
    },
    adopt: (handover) => {
      const pending = recovery;

      adoptions = adoptions
        .then(async () => {
          // Standby is decided by the recovery; adopting waits for it.
          await pending?.catch(() => undefined);
          await service.handover.adopt(handover.live);
        })
        .catch((error: unknown) => {
          log.error('Project adoption failed', { err: error });
        });

      return adoptions;
    },
    drain: (released) => service.handover.drain(released),
    dispose: () => {
      disposal ??= service.dispose();
      return disposal;
    },
  };
};

/**
 * The host's start and stop steps of the runtime (M3). The start step
 * reconciles the persisted Projects and Threads, at the
 * `workspace_reconciliation` stage, and logs what it found; the stop step
 * ends the running prompts, before the other bundles deactivate.
 */
export const installStartStop = ({
  services,
  lifecycle,
}: {
  readonly services: Pick<Services, 'use'>;
  readonly lifecycle: RuntimeLifecycle;
}): Disposable => {
  const hooks = services.use(HooksV1).use(AppHooksV1);
  const startup = () => services.use(DoricStartupV1);

  const start = hooks.onHostStartHook(async (_input, call) => {
    await startup().stage('workspace_reconciliation');
    await startup().log(
      {
        level: 'info',
        fields: {},
        message: 'Reconciling persisted projects and threads',
      },
      call,
    );

    const { interruptedThreads, interruptedProjects } =
      await lifecycle.recover();

    await startup().log(
      {
        level: 'info',
        fields: { interruptedThreads, interruptedProjects },
        message: 'Workspace reconciled',
      },
      call,
    );
  });
  const stop = hooks.onHostStopHook(async () => {
    // Running prompts are suspended while their tool bundles are active.
    await lifecycle.dispose();
  });

  return {
    dispose: () => {
      start.dispose();
      stop.dispose();
    },
  };
};
