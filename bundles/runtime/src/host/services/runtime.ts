import { defineMethod, defineService, type Log } from 'bundle/contracts';

import {
  type Handover,
  type RecoverySummary,
  RuntimeV1,
  runtimeMethods,
} from '../../contracts/runtime.js';
import type { Notices } from '../domain/notices.js';
import type { WorkspaceService } from '../domain/types.js';
import type { ProjectStore, ThreadStore } from '../store/types.js';

/*
 * runtime/v1 (design 57 §2.2, §4.9): Projects, the boot recovery, the host
 * stop and the live notices, one method per WorkspaceService operation.
 */
export const runtimeService = ({
  service,
  notices,
  projects,
  threads,
  log,
}: {
  readonly service: WorkspaceService;
  readonly notices: Notices;
  readonly projects: ProjectStore;
  readonly threads: ThreadStore;
  readonly log: Log;
}) => {
  let recovery: Promise<RecoverySummary> | undefined;
  let disposal: Promise<void> | undefined;
  /** Adoptions run one at a time, after the recovery. */
  let adoptions: Promise<void> = Promise.resolve();
  /**
   * Today's boot sequence (agents/doric index.ts), once per runtime process.
   * The Projects a live process in the handover owns are left out (57-WP-H).
   */
  const recover = async (handover?: Handover): Promise<RecoverySummary> => {
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

  return defineService(RuntimeV1, {
    recover: defineMethod({
      ...runtimeMethods.recover,
      execute: () => {
        // A second call answers the first summary without doing the work again.
        recovery ??= recover();
        return recovery;
      },
    }),
    recoverWith: defineMethod({
      ...runtimeMethods.recoverWith,
      execute: (handover) => {
        recovery ??= recover(handover);
        return recovery;
      },
    }),
    adopt: defineMethod({
      ...runtimeMethods.adopt,
      execute: (handover) => {
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
    }),
    drain: defineMethod({
      ...runtimeMethods.drain,
      execute: (released) => service.handover.drain(released),
    }),
    dispose: defineMethod({
      ...runtimeMethods.dispose,
      execute: () => {
        disposal ??= service.dispose();
        return disposal;
      },
    }),
    createProject: defineMethod({
      ...runtimeMethods.createProject,
      execute: ({ name }) => service.projects.create(name),
    }),
    project: defineMethod({
      ...runtimeMethods.project,
      execute: (id) => service.projects.find(id),
    }),
    projects: defineMethod({
      ...runtimeMethods.projects,
      execute: ({ limit, cursor }) => service.projects.list(limit, cursor),
    }),
    renameProject: defineMethod({
      ...runtimeMethods.renameProject,
      execute: ({ id, name }) => service.projects.rename(id, name),
    }),
    setProjectColor: defineMethod({
      ...runtimeMethods.setProjectColor,
      execute: ({ id, color }) =>
        service.projects.setColor(id, color ?? undefined),
    }),
    terminateProject: defineMethod({
      ...runtimeMethods.terminateProject,
      execute: (id) => service.projects.terminate(id),
    }),
    deleteProject: defineMethod({
      ...runtimeMethods.deleteProject,
      execute: (id) => service.projects.delete(id),
    }),
    vmSsh: defineMethod({
      ...runtimeMethods.vmSsh,
      execute: (vmId) => service.sshForVm(vmId),
    }),
    watch: defineMethod({
      ...runtimeMethods.watch,
      execute: (listener) => notices.watch(listener),
    }),
  });
};
