import type { Logger } from 'pino';
import type { Sandpool } from 'sandpool';

import type { ConfigService } from '../config/service.js';
import { runDirectPrompt } from '../agents/direct/executor.js';
import { randomProjectColor } from './colors.js';
import { createThreadRunner } from './runner.js';
import {
  createMutationQueue,
  subtreeIds,
  type ProjectRuntime,
  type ThreadExecution,
} from './runtime.js';
import {
  isTerminal,
  type ProjectStore,
  type ThreadStore,
  type WorkspacePublisher,
  type WorkspaceService,
  type Project,
  type ProjectSsh,
} from './types.js';

export type { ThreadExecution } from './runtime.js';

type Options = {
  readonly projects: ProjectStore;
  readonly threads: ThreadStore;
  readonly config: ConfigService;
  readonly pool: Sandpool;
  readonly publisher: WorkspacePublisher;
  readonly logger: Logger;
  readonly execute?: ThreadExecution;
};

/** Composes project-owned sandboxes with independently scheduled conversations. */
export const createWorkspaceService = ({
  projects,
  threads,
  config,
  pool,
  publisher,
  logger,
  execute = runDirectPrompt,
}: Options): WorkspaceService => {
  const runtimes = new Map<string, ProjectRuntime>();
  const exclusive = createMutationQueue();
  const runner = createThreadRunner({
    threads,
    publisher,
    logger,
    execute,
    exclusive,
  });
  let disposed = false;

  const setProject = async (
    runtime: ProjectRuntime,
    state: ProjectRuntime['project']['state'],
    errorCode?: string,
  ) => {
    const value = await projects.setState(runtime.project.id, state, errorCode);
    if (value !== undefined) {
      runtime.project = value;
      publisher.projectUpdated(value);
    }
  };
  // Called under the project lock. Cleanup never waits while holding that lock.
  const endProject = async (runtime: ProjectRuntime, failure?: string) => {
    if (runtime.closing) return runtime.project;
    runtime.closing = true;
    runtime.controller.abort();
    // Cancellation and lease cleanup must not depend on database availability.
    for (const thread of runtime.threads.values())
      thread.active?.controller.abort();
    runtime.project = { ...runtime.project, state: 'cancelling' };
    await setProject(runtime, 'cancelling').catch(() => {
      logger.error(
        { projectId: runtime.project.id },
        'Project cancellation persistence failed',
      );
    });
    await runner.close(runtime, [...runtime.threads.values()], failure);
    runtime.ending = Promise.resolve()
      .then(async () => {
        await runtime.acquisition;
        await Promise.all(
          [...runtime.threads.values()].map(async (thread) => {
            await thread.task;
            await thread.ending;
          }),
        );
        let errorCode = failure;
        const lease = runtime.lease;
        runtime.lease = undefined;
        if (lease !== undefined) {
          try {
            await lease.release();
          } catch {
            errorCode = 'sandbox_release_failed';
          }
        }
        await exclusive(runtime.project.id, async () => {
          try {
            await setProject(
              runtime,
              errorCode === undefined ? 'cancelled' : 'failed',
              errorCode,
            );
          } finally {
            runtimes.delete(runtime.project.id);
          }
        });
      })
      .catch(() => {
        logger.error(
          { projectId: runtime.project.id },
          'Project termination persistence failed',
        );
      });
    return runtime.project;
  };
  const acquire = async (runtime: ProjectRuntime) => {
    try {
      const lease = await pool.acquire({ signal: runtime.controller.signal });
      await exclusive(runtime.project.id, async () => {
        runtime.lease = lease;
        if (runtime.closing) return;
        await setProject(runtime, 'ready');
        for (const thread of runtime.threads.values()) {
          if (thread.closing) continue;
          await runner.state(thread, 'ready');
          runner.start(runtime, thread);
        }
      });
    } catch {
      await exclusive(runtime.project.id, async () => {
        if (!runtime.closing)
          await endProject(runtime, 'sandbox_acquisition_failed');
      });
    }
  };
  const ssh = async (id: string): Promise<ProjectSsh> => {
    const runtime = runtimes.get(id);
    if (runtime === undefined) {
      const record = await projects.find(id);
      return {
        status:
          record === undefined
            ? 'missing'
            : isTerminal(record.project.state)
              ? 'expired'
              : 'unavailable',
      };
    }
    if (runtime.closing) return { status: 'unavailable' };
    if (runtime.lease === undefined) return { status: 'pending' };
    const access = await runtime.lease.sandbox.ssh();
    // Disposal may have started during the provider call.
    if (runtime.closing || runtime.lease === undefined)
      return { status: 'unavailable' };
    return access === undefined
      ? { status: 'unavailable' }
      : { status: 'ready', vmId: runtime.lease.sandbox.id, ssh: access };
  };
  const changeProject = (
    id: string,
    change: () => Promise<Project | undefined>,
  ) =>
    exclusive(id, async () => {
      const value = await change();
      if (value !== undefined) {
        const runtime = runtimes.get(id);
        if (runtime !== undefined) runtime.project = value;
        publisher.projectUpdated(value);
      }
      return value;
    });
  return {
    projects: {
      create: (name) =>
        exclusive('creation', async () => {
          if (disposed) throw new Error('Doric is shutting down.');
          const generation = config.current();
          const record = await projects.create(
            name,
            generation.snapshot,
            randomProjectColor(),
          );
          const runtime: ProjectRuntime = {
            project: record.project,
            generation,
            controller: new AbortController(),
            threads: new Map(),
            closing: false,
          };
          runtimes.set(record.project.id, runtime);
          publisher.projectUpdated(record.project);
          runtime.acquisition = acquire(runtime).catch(() => {
            logger.error(
              { projectId: runtime.project.id },
              'Project acquisition persistence failed',
            );
          });
          return record.project;
        }),
      find: async (id) => (await projects.find(id))?.project,
      list: (limit, cursor) => projects.list(limit, cursor),
      rename: (id, name) => changeProject(id, () => projects.rename(id, name)),
      setColor: (id, color) =>
        changeProject(id, () => projects.setColor(id, color)),
      terminate: (id) =>
        exclusive(id, async () => {
          const runtime = runtimes.get(id);
          return runtime === undefined
            ? (await projects.find(id))?.project
            : endProject(runtime);
        }),
      delete: (id) =>
        exclusive(id, async () => {
          const values = await threads.listByProject(id);
          const outcome = await projects.delete(id);
          if (outcome === 'deleted') {
            for (const thread of values) publisher.threadDeleted(id, thread.id);
            publisher.projectDeleted(id);
            runtimes.delete(id);
          }
          return outcome;
        }),
      ssh,
    },
    threads: {
      create: (projectId, name, parentThreadId) =>
        exclusive(projectId, async () => {
          const runtime = runtimes.get(projectId);
          if (runtime === undefined)
            return {
              status:
                (await projects.find(projectId)) === undefined
                  ? ('missing' as const)
                  : ('inactive' as const),
            };
          return runner.create(runtime, name, parentThreadId);
        }),
      find: async (id) => (await threads.find(id))?.thread,
      list: async (projectId, limit, cursor, parentThreadId) =>
        (await projects.find(projectId)) === undefined
          ? undefined
          : threads.list(projectId, limit, cursor, parentThreadId),
      rename: async (id, name) => {
        const record = await threads.find(id);
        if (record === undefined) return undefined;
        return exclusive(record.thread.projectId, async () => {
          const value = await threads.rename(id, name);
          if (value !== undefined) {
            const runtime = runtimes
              .get(record.thread.projectId)
              ?.threads.get(id);
            if (runtime !== undefined) runtime.thread = value;
            publisher.threadUpdated(value);
          }
          return value;
        });
      },
      prompt: async (id, prompt) => {
        const record = await threads.find(id);
        if (record === undefined) return { status: 'missing' };
        return exclusive(record.thread.projectId, async () => {
          const project = runtimes.get(record.thread.projectId);
          const thread = project?.threads.get(id);
          if (project === undefined || thread === undefined)
            return { status: 'inactive' as const };
          return runner.enqueue(project, thread, prompt, { kind: 'user' });
        });
      },
      rewind: async (id, promptId, prompt) => {
        const record = await threads.find(id);
        if (record === undefined) return { status: 'missing' };
        return exclusive(record.thread.projectId, async () => {
          const project = runtimes.get(record.thread.projectId);
          const thread = project?.threads.get(id);
          if (project === undefined || thread === undefined)
            return { status: 'inactive' as const };
          return runner.rewind(project, thread, promptId, prompt);
        });
      },
      events: async (id, afterSequence) => {
        const record = await threads.find(id);
        if (record === undefined) return undefined;
        const events = await threads.eventsAfter(id, afterSequence);
        return {
          events,
          lastSequence: Math.max(
            record.thread.lastSequence,
            events.at(-1)?.sequence ?? 0,
          ),
        };
      },
      interrupt: async (id, promptId) => {
        const record = await threads.find(id);
        if (record === undefined) return 'missing';
        return exclusive(record.thread.projectId, async () => {
          const thread = runtimes.get(record.thread.projectId)?.threads.get(id);
          return thread === undefined
            ? 'inactive'
            : runner.interrupt(thread, promptId);
        });
      },
      terminate: async (id) => {
        const record = await threads.find(id);
        if (record === undefined) return undefined;
        return exclusive(record.thread.projectId, async () => {
          const project = runtimes.get(record.thread.projectId);
          if (project === undefined) return record.thread;
          await runner.close(project, runner.descendants(project, id));
          return project.threads.get(id)?.thread ?? record.thread;
        });
      },
      delete: async (id) => {
        const record = await threads.find(id);
        if (record === undefined) return 'missing';
        return exclusive(record.thread.projectId, async () => {
          const values = await threads.listByProject(record.thread.projectId);
          const ids = subtreeIds(values, id);
          const outcome = await threads.deleteSubtree(id);
          if (outcome === 'deleted')
            for (const child of ids) {
              runtimes.get(record.thread.projectId)?.threads.delete(child);
              publisher.threadDeleted(record.thread.projectId, child);
            }
          return outcome;
        });
      },
    },
    sshForVm: async (id) => {
      const runtime = [...runtimes.values()].find(
        (value) => !value.closing && value.lease?.sandbox.id === id,
      );
      if (runtime === undefined) return undefined;
      const access = await ssh(runtime.project.id);
      return access.status === 'ready'
        ? { projectId: runtime.project.id, ssh: access.ssh }
        : undefined;
    },
    dispose: async () => {
      await exclusive('creation', async () => {
        disposed = true;
      });
      const values = [...runtimes.values()];
      await Promise.all(
        values.map((runtime) =>
          exclusive(runtime.project.id, async () => {
            await endProject(runtime);
          }),
        ),
      );
      await Promise.all(values.map((runtime) => runtime.ending));
    },
  };
};
