import type { Logger } from 'pino';

import {
  listSandboxDirectory,
  listSandboxTree,
  type Sandbox,
  workspacePathKind,
} from 'sandbox';
import type { Sandpool } from 'sandpool';

import { runDirectPrompt } from '../agents/direct/executor.js';
import type { ConfigInput } from '../config/schema.js';
import type { ConfigService } from '../config/service.js';
import type { CredentialKind } from '../credentials/kind.js';
import type { CredentialService } from '../credentials/service.js';
import { randomProjectColor } from './colors.js';
import { projectChanges, readProjectFile } from './files.js';
import {
  applyGitCredentials,
  type GitCredentials,
  sameGitCredentials,
} from './git.js';
import { createThreadRunner } from './runner.js';
import {
  createMutationQueue,
  type ProjectRuntime,
  subtreeIds,
  type ThreadExecution,
} from './runtime.js';
import {
  isTerminal,
  type Project,
  type ProjectDiff,
  type ProjectFile,
  type ProjectFiles,
  type ProjectSsh,
  type ProjectStore,
  type ProjectTree,
  type ThreadStore,
  type WorkspacePublisher,
  type WorkspaceService,
} from './types.js';

export type { ThreadExecution } from './runtime.js';

/** The lease-dependent answer a Project subresource can give before its value. */
type LeaseOutcome<Value> =
  | { readonly status: 'missing' | 'pending' | 'unavailable' | 'expired' }
  | { readonly status: 'ready'; readonly value: Value };

type Options = {
  readonly projects: ProjectStore;
  readonly threads: ThreadStore;
  readonly config: ConfigService;
  readonly credentials: CredentialService;
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
  credentials,
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
  /**
   * Resolves the Git identity and the GitHub token the current configuration
   * names. A configured choice resolves by id; without one, the integration asks
   * for the kind it needs, where no match means it stays off. A missing or
   * ambiguous reference costs only its own half, is surfaced as a warning naming
   * the reason, and never breaks the prompt that needed the credential.
   *
   * The GitHub token is resolved only among the credentials no provider claims,
   * because a provider key and a GitHub token are both `API_TOKEN`: without this,
   * an operator who filled in a provider key and chose no GitHub credential would
   * have that key written into the sandbox's git credential store and `gh` hosts
   * file. A token is therefore authenticated with only when it was named, or when
   * it is the one `API_TOKEN` credential nothing else uses.
   */
  const gitCredentials = (
    configuration: ConfigInput,
    projectId: string,
  ): GitCredentials => {
    const identity = select(configuration.gitCredentialId, 'GIT', projectId);
    const token = select(
      configuration.githubCredentialId,
      'API_TOKEN',
      projectId,
      new Set(configuration.providers.map(({ credentialId }) => credentialId)),
    );

    return {
      ...(identity?.username === undefined || identity.email === undefined
        ? {}
        : { identity: { username: identity.username, email: identity.email } }),
      ...(token?.secret === undefined || token.secret === ''
        ? {}
        : { token: token.secret }),
    };
  };
  const select = (
    id: string | undefined,
    kind: CredentialKind,
    projectId: string,
    claimed?: ReadonlySet<string>,
  ) => {
    try {
      if (id !== undefined) return credentials.byId(id);
      return claimed === undefined
        ? credentials.byKind(kind)
        : credentials.byUnclaimedKind(kind, claimed);
    } catch (error) {
      logger.warn(
        { projectId },
        `A credential was not applied: ${
          error instanceof Error ? error.message : 'unknown failure'
        }`,
      );

      return undefined;
    }
  };
  const acquire = async (runtime: ProjectRuntime) => {
    try {
      const lease = await pool.acquire({ signal: runtime.controller.signal });
      // The captured credentials are what a fresh sandbox starts with, and the
      // next prompt re-applies the current ones when they have moved on.
      const git = gitCredentials(
        runtime.generation.snapshot.configuration,
        runtime.project.id,
      );
      await applyGitCredentials(lease.sandbox, git, {
        logger,
        projectId: runtime.project.id,
      });
      runtime.appliedGit = git;
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
  /**
   * The Git identity and the GitHub token follow the current configuration, so a
   * rotated or newly saved credential reaches a Project that is already running,
   * while every other configuration value stays captured in the Project's
   * generation. The pair is compared with the one the sandbox last received, so an
   * unchanged configuration never re-runs commands, and the writes stay off the
   * project lock because a credential is not a lifecycle mutation.
   */
  const applyCurrentGit = async (runtime: ProjectRuntime | undefined) => {
    const sandbox = runtime?.lease?.sandbox;
    if (runtime === undefined || sandbox === undefined || runtime.closing)
      return;
    const git = gitCredentials(
      config.current().snapshot.configuration,
      runtime.project.id,
    );
    if (sameGitCredentials(runtime.appliedGit, git)) return;
    await applyGitCredentials(sandbox, git, {
      logger,
      projectId: runtime.project.id,
    });
    runtime.appliedGit = git;
    // This Project's captured generation predates any rotation, so the new token
    // is registered for redaction before anything can carry it into an event.
    if (git.token !== undefined) {
      runtime.generation.registerSecret(git.token);
    }
  };
  /**
   * Resolves a Project lease for one operation, so every lease-dependent
   * subresource reports missing/pending/unavailable/expired identically. The
   * closing check runs again after the operation, because disposal may have
   * started or the lease may have been dropped while it ran.
   */
  const withLease = async <Value>(
    id: string,
    operation: (sandbox: Sandbox) => Promise<Value>,
  ): Promise<LeaseOutcome<Value>> => {
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
    const value = await operation(runtime.lease.sandbox);
    // Disposal may have started during the operation.
    if (runtime.closing || runtime.lease === undefined)
      return { status: 'unavailable' };
    return { status: 'ready', value };
  };
  const ssh = async (id: string): Promise<ProjectSsh> => {
    const outcome = await withLease(id, async (sandbox) => ({
      vmId: sandbox.id,
      ssh: await sandbox.ssh(),
    }));
    if (outcome.status !== 'ready') return { status: outcome.status };
    return outcome.value.ssh === undefined
      ? { status: 'unavailable' }
      : { status: 'ready', vmId: outcome.value.vmId, ssh: outcome.value.ssh };
  };
  const files = async (id: string, path?: string): Promise<ProjectFiles> => {
    const outcome = await withLease(id, (sandbox) =>
      listSandboxDirectory(sandbox, { path: path ?? '' }),
    );
    if (outcome.status !== 'ready') return { status: outcome.status };
    if (outcome.value.status === 'listed')
      return {
        status: 'ready',
        path: outcome.value.path,
        entries: outcome.value.entries,
      };
    if (outcome.value.status === 'missing') return { status: 'not_found' };
    // `invalid_exclude` and `excluded_root` are unreachable: no excludes are sent.
    return {
      status:
        outcome.value.status === 'not_directory'
          ? 'not_directory'
          : 'invalid_path',
    };
  };
  const tree = async (id: string, path?: string): Promise<ProjectTree> => {
    const outcome = await withLease(id, (sandbox) =>
      listSandboxTree(sandbox, { path: path ?? '' }),
    );
    if (outcome.status !== 'ready') return { status: outcome.status };
    if (outcome.value.status === 'listed')
      return {
        status: 'ready',
        path: outcome.value.path,
        entries: outcome.value.entries,
      };
    if (outcome.value.status === 'missing') return { status: 'not_found' };
    // `invalid_exclude` and `excluded_root` are unreachable: no excludes are sent.
    return {
      status:
        outcome.value.status === 'not_directory'
          ? 'not_directory'
          : 'invalid_path',
    };
  };
  const file = async (id: string, path: string): Promise<ProjectFile> => {
    const outcome = await withLease(id, (sandbox) =>
      readProjectFile(sandbox, path),
    );
    if (outcome.status !== 'ready') return { status: outcome.status };
    if (outcome.value.status === 'read')
      return {
        status: 'ready',
        path,
        content: outcome.value.content,
        truncated: outcome.value.truncated,
        binary: outcome.value.binary,
      };
    if (outcome.value.status === 'missing') return { status: 'not_found' };
    return {
      status: outcome.value.status === 'not_file' ? 'not_file' : 'invalid_path',
    };
  };
  const diff = async (id: string, path?: string): Promise<ProjectDiff> => {
    const outcome = await withLease(id, async (sandbox) => {
      if (path !== undefined) {
        const kind = await workspacePathKind(sandbox, path);
        if (kind === 'escaped') return { status: 'invalid_path' as const };
        if (kind === 'missing') return { status: 'not_found' as const };
      }
      const repositories = await projectChanges(sandbox);
      return {
        status: 'ready' as const,
        ...(path === undefined ? {} : { path }),
        repositories,
      };
    });
    if (outcome.status !== 'ready') return { status: outcome.status };
    return outcome.value;
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
      files,
      file,
      tree,
      diff,
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
        // New input is the point where a live sandbox catches up with a rotated
        // or newly saved credential, before the prompt is enqueued.
        await applyCurrentGit(runtimes.get(record.thread.projectId));
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
        // A rewind enqueues its replacement input the same way a prompt does.
        await applyCurrentGit(runtimes.get(record.thread.projectId));
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
