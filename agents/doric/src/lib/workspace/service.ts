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
import { providerCredentials } from '../config/schema.js';
import type { ConfigService } from '../config/service.js';
import type { CredentialKind } from '../credentials/kind.js';
import type { CredentialService } from '../credentials/service.js';
import { readBranches, switchBranch } from './branches.js';
import { randomProjectColor } from './colors.js';
import { workingDirectoriesInside } from './cwd.js';
import { readProjectChanges, readProjectFileDiff } from './file-changes.js';
import { projectChanges, readProjectFile } from './files.js';
import {
  applyGitCredentials,
  type GitCredentials,
  sameGitCredentials,
} from './git.js';
import { threadGit } from './git-status.js';
import {
  hostOwesRun,
  type PromptProgress,
  resumeExhausted,
  resumeExhaustedError,
} from './prompts.js';
import { queuedPrompt } from './queue.js';
import { createThreadRunner } from './runner.js';
import {
  createMutationQueue,
  type ProjectRuntime,
  type PromptJob,
  subtreeIds,
  type ThreadExecution,
  type ThreadRuntime,
} from './runtime.js';
import { createTerminalRegistry } from './terminals.js';
import {
  isTerminal,
  type Project,
  type ProjectChanges,
  type ProjectDiff,
  type ProjectFile,
  type ProjectFileDiff,
  type ProjectFiles,
  type ProjectSsh,
  type ProjectStore,
  type ProjectTree,
  type Thread,
  type ThreadStore,
  type WorkspacePublisher,
  type WorkspaceService,
} from './types.js';
import { withContextCapacity } from './usage-context.js';

export type { ThreadExecution } from './runtime.js';

/** The lease-dependent answer a Project subresource can give before its value. */
type LeaseOutcome<Value> =
  | { readonly status: 'missing' | 'pending' | 'unavailable' | 'expired' }
  | { readonly status: 'ready'; readonly value: Value };

interface Options {
  readonly projects: ProjectStore;
  readonly threads: ThreadStore;
  readonly config: ConfigService;
  readonly credentials: CredentialService;
  readonly pool: Sandpool;
  readonly publisher: WorkspacePublisher;
  readonly logger: Logger;
  /**
   * Discards a deleted Project's durable workspace volume. The service calls it
   * after the record is gone; a rejection is logged and never fails the deletion.
   */
  readonly discardWorkspace: (identity: string) => Promise<void>;
  readonly execute?: ThreadExecution;
}

/**
 * The job a resumed prompt re-runs: the prompt's own id, so its events keep
 * belonging to the same turn, and the input the log accepted, which the resumed
 * run continues rather than repeats.
 */
const jobFor = (prompt: PromptProgress): PromptJob => ({
  id: prompt.promptId,
  prompt: prompt.text,
  source: prompt.source,
});

/** Composes project-owned sandboxes with independently scheduled conversations. */
export const createWorkspaceService = ({
  projects,
  threads,
  config,
  credentials,
  pool,
  publisher,
  logger,
  discardWorkspace,
  execute = runDirectPrompt,
}: Options): WorkspaceService => {
  const runtimes = new Map<string, ProjectRuntime>();
  const exclusive = createMutationQueue();
  const terminals = createTerminalRegistry(publisher, () =>
    config.current().redactions(),
  );
  const runner = createThreadRunner({
    terminals,
    threads,
    publisher,
    logger,
    execute,
    generation: () => config.current(),
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
        const errorCode = (await releaseLease(runtime)) ?? failure;
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
   * Ends every live Project of a host that is stopping without terminating it:
   * the lease is released, the Project is written back as `queued` (it needs a
   * sandbox again), and its non-terminal Threads as `ready`, while any prompt
   * that was running is paused for the next boot. Called
   * under the project lock; cleanup never waits while holding that lock.
   */
  const suspendProject = (runtime: ProjectRuntime) => {
    if (runtime.closing) return runtime.project;
    runtime.closing = true;
    runtime.controller.abort();
    for (const thread of runtime.threads.values())
      thread.active?.controller.abort();
    runner.suspend(runtime, [...runtime.threads.values()]);
    runtime.ending = Promise.resolve()
      .then(async () => {
        await runtime.acquisition;
        await Promise.all(
          [...runtime.threads.values()].map(async (thread) => {
            await thread.task;
            await thread.ending;
          }),
        );
        const errorCode = await releaseLease(runtime);
        await exclusive(runtime.project.id, async () => {
          try {
            // A host stop never terminates a Project, so even a lease that would
            // not release leaves it resumable rather than `failed`.
            await setProject(runtime, 'queued', errorCode);
          } finally {
            runtimes.delete(runtime.project.id);
          }
        });
      })
      .catch(() => {
        logger.error(
          { projectId: runtime.project.id },
          'Project suspension persistence failed',
        );
      });
    return runtime.project;
  };
  /**
   * Releases the Project lease exactly once, after active work has settled. A
   * failure is reported as the `sandbox_release_failed` code rather than thrown,
   * so a stop continues even when the provider cannot confirm the release.
   */
  const releaseLease = async (
    runtime: ProjectRuntime,
  ): Promise<string | undefined> => {
    const lease = runtime.lease;
    runtime.lease = undefined;
    if (lease === undefined) return undefined;
    try {
      await lease.release();
      return undefined;
    } catch {
      return 'sandbox_release_failed';
    }
  };
  /**
   * Resolves the Git identity and the GitHub token the current configuration
   * names. A configured choice resolves by id; without one, the integration asks
   * for the kind it needs, where no match means it stays off. A missing or
   * ambiguous reference costs only its own half, is surfaced as a warning naming
   * the reason, and never breaks the prompt that needed the credential.
   *
   * The GitHub token is resolved only among the credentials no provider names,
   * because a provider's token and a GitHub token are both `API_TOKEN`: without
   * this, an operator who filled in a provider key and chose no GitHub credential
   * would have that key written into the sandbox's git credential store and `gh`
   * hosts file. A token is therefore authenticated with only when it was named,
   * or when it is the one `API_TOKEN` credential nothing else uses.
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
      new Set(
        configuration.providers.flatMap((provider) =>
          providerCredentials(provider).map(({ id }) => id),
        ),
      ),
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
      const lease = await pool.acquire({
        signal: runtime.controller.signal,
        // The pool hands an identified acquisition the Project's own durable
        // workspace, so a resumed Project comes back to the same files.
        identity: runtime.project.id,
      });
      // The credentials in force are what a fresh sandbox starts with, and the
      // next prompt re-applies them when they have moved on.
      const git = gitCredentials(
        config.current().snapshot.configuration,
        runtime.project.id,
      );
      await applyGitCredentials(lease.sandbox, git, {
        logger,
        projectId: runtime.project.id,
      });
      runtime.appliedGit = git;
      // A reacquired sandbox may be a fresh volume: every Thread whose directory
      // is not the workspace root is probed in one command, and every directory
      // it no longer holds is reset before any Thread runs.
      const resets = await missingDirectories(runtime, lease.sandbox);
      await exclusive(runtime.project.id, async () => {
        runtime.lease = lease;
        if (runtime.closing) return;
        await setProject(runtime, 'ready');
        for (const thread of resets) await runner.resetCwd(runtime, thread);
        for (const thread of runtime.threads.values()) {
          if (thread.closing || isTerminal(thread.thread.state)) continue;
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
   * The Threads whose working directory a just-acquired sandbox no longer holds.
   * The probe is one sandbox command for every candidate path, so a resumed
   * Project with many Threads pays one round trip, and a Thread already at the
   * workspace root is never named to it.
   */
  const missingDirectories = async (
    runtime: ProjectRuntime,
    sandbox: Sandbox,
  ): Promise<readonly ThreadRuntime[]> => {
    const root = sandbox.root;
    const candidates = [...runtime.threads.values()].filter(
      (thread) =>
        !thread.closing &&
        !isTerminal(thread.thread.state) &&
        thread.thread.cwd !== root,
    );
    if (candidates.length === 0) return [];
    const kept = await workingDirectoriesInside(
      sandbox,
      root,
      candidates.map((thread) => thread.thread.cwd),
    );
    // A probe that could not run proves nothing, so its directories are kept:
    // the acquisition still becomes ready rather than resetting them silently.
    if (kept === undefined) {
      logger.debug(
        { projectId: runtime.project.id },
        'Working directory probe could not run; keeping stored directories',
      );
      return [];
    }
    return candidates.filter((thread) => !kept.has(thread.thread.cwd));
  };
  /** Builds the process-local runtime for one durable Project, or `undefined`. */
  const runtimeFromStored = async (
    id: string,
  ): Promise<ProjectRuntime | undefined> => {
    const record = await projects.record(id);
    if (record === undefined) return undefined;
    const values = await threads.listByProject(id);
    const runtime: ProjectRuntime = {
      project: record,
      controller: new AbortController(),
      threads: new Map(
        values.map((thread) => [
          thread.id,
          { thread, jobs: [], closing: false },
        ]),
      ),
      closing: false,
    };
    runtimes.set(id, runtime);
    return runtime;
  };
  /**
   * Brings a durable, non-terminal Project back at boot or on demand: it loads the Project
   * and its Threads and starts the acquisition, so a prompt reaching a Project
   * the host has not resumed yet reacquires its sandbox first. It runs under the
   * creation lock, so a shutting-down host can never add a runtime after it set
   * its flag, and a read never calls it, so reading does not resume a Project.
   */
  const resumeProject = async (
    id: string,
  ): Promise<ProjectRuntime | undefined> =>
    exclusive('creation', async () => {
      if (disposed) return undefined;
      const existing = runtimes.get(id);
      if (existing !== undefined) return existing;
      const record = await projects.record(id);
      if (
        record === undefined ||
        isTerminal(record.state) ||
        record.state === 'cancelling'
      )
        return undefined;
      const runtime = await runtimeFromStored(id);
      if (runtime === undefined) return undefined;
      runtime.resumed = true;
      runtime.acquisition = acquire(runtime).catch(() => {
        logger.error(
          { projectId: id },
          'Project acquisition persistence failed',
        );
      });
      return runtime;
    });
  /**
   * The runtime a new turn needs: the Project's live one, or one brought back
   * from durable state on demand. A prompt to a just-resumed Project waits for
   * the acquisition in flight before it enqueues, so prompts that race to bring
   * it back keep arrival order rather than the second running ahead of the
   * first; a Project that could not come back is not a runtime at all.
   */
  const projectFor = async (
    projectId: string,
  ): Promise<ProjectRuntime | undefined> => {
    const runtime = runtimes.get(projectId) ?? (await resumeProject(projectId));
    if (runtime === undefined) return undefined;
    if (runtime.resumed === true) {
      await runtime.acquisition;
      if (runtime.closing || runtime.lease === undefined) return undefined;
    }
    return runtime;
  };
  /**
   * Cancels a Thread and its subtree for a Project the host has no runtime for.
   * The live path runs `runner.close`, which has in-memory jobs to settle; here
   * there are none, so the store is taken through `cancelling` and then
   * `cancelled`, publishing each change, and the target Thread is answered in
   * the shape the live path answers. Deletion then works on the terminal subtree
   * exactly as it does after a live termination.
   */
  const terminateStored = async (
    projectId: string,
    id: string,
  ): Promise<Thread | undefined> => {
    const values = await threads.listByProject(projectId);
    const ids = subtreeIds(values, id);
    const targets = values.filter(
      (value) => ids.has(value.id) && !isTerminal(value.state),
    );
    for (const value of targets) {
      const cancelling = await threads.setState(value.id, 'cancelling');
      if (cancelling !== undefined) publisher.threadUpdated(cancelling);
    }
    let target: Thread | undefined;
    for (const value of targets) {
      const cancelled = await threads.setState(value.id, 'cancelled');
      if (cancelled !== undefined) publisher.threadUpdated(cancelled);
      if (value.id === id) target = cancelled;
    }
    return target ?? (await threads.record(id));
  };
  /**
   * The Git identity and the GitHub token follow the current configuration, so a
   * rotated or newly saved credential reaches a Project that is already running.
   * The pair is compared with the one the sandbox last received, so an unchanged
   * configuration never re-runs commands, and the writes stay off the project
   * lock because a credential is not a lifecycle mutation.
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
    // The host just wrote this token into a sandbox, so it must never surface in
    // an event or a log line, whether or not the credential store still holds it.
    if (git.token !== undefined) credentials.register(git.token);
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
      const record = await projects.record(id);
      return {
        status:
          record === undefined
            ? 'missing'
            : isTerminal(record.state)
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
      // Discovery is scoped to the requested path, so the renderer reads the
      // changes of one Thread's working directory rather than the whole sandbox.
      const repositories = await projectChanges(sandbox, path ?? '');
      return {
        status: 'ready' as const,
        ...(path === undefined ? {} : { path }),
        repositories,
      };
    });
    if (outcome.status !== 'ready') return { status: outcome.status };
    return outcome.value;
  };
  const changes = async (
    id: string,
    path?: string,
  ): Promise<ProjectChanges> => {
    const outcome = await withLease(id, async (sandbox) => {
      if (path !== undefined) {
        const kind = await workspacePathKind(sandbox, path);
        if (kind === 'escaped') return { status: 'invalid_path' as const };
        if (kind === 'missing') return { status: 'not_found' as const };
      }
      return {
        status: 'ready' as const,
        ...(path === undefined ? {} : { path }),
        repositories: await readProjectChanges(sandbox, path),
      };
    });
    return outcome.status === 'ready'
      ? outcome.value
      : { status: outcome.status };
  };
  const fileDiff = async (
    id: string,
    repository: string,
    path: string,
  ): Promise<ProjectFileDiff> => {
    if (
      [repository, path].some(
        (value) =>
          value.includes('\0') ||
          value.startsWith('/') ||
          value.split('/').includes('..'),
      ) ||
      path === ''
    )
      return { status: 'invalid_path' };
    const outcome = await withLease(id, async (sandbox) => {
      const diff = await readProjectFileDiff(sandbox, repository, path);
      return diff === undefined
        ? { status: 'not_found' as const }
        : { status: 'ready' as const, diff };
    });
    return outcome.status === 'ready'
      ? outcome.value
      : { status: outcome.status };
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
    terminals: {
      list: terminals.list,
      snapshot: terminals.snapshot,
      input: terminals.input,
      resize: terminals.resize,
      stop: terminals.stop,
      create: async (threadId, cols, rows) => {
        const record = await threads.record(threadId);
        if (record === undefined || isTerminal(record.state)) return undefined;
        const project = await projectFor(record.projectId);
        if (project === undefined) return undefined;
        return exclusive(record.projectId, async () => {
          const thread = project.threads.get(threadId);
          const sandbox = project.lease?.sandbox;
          if (
            project.closing ||
            thread === undefined ||
            thread.closing ||
            sandbox === undefined
          )
            return undefined;
          const started = await terminals.start({
            sandbox,
            projectId: record.projectId,
            threadId,
            origin: 'user',
            input: {
              command: 'bash',
              cwd: thread.thread.cwd,
              timeoutMs: 0,
              pty: true,
            },
            ...(cols === undefined ? {} : { cols }),
            ...(rows === undefined ? {} : { rows }),
          });
          return started.terminal;
        });
      },
    },
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
      find: (id) => projects.record(id),
      list: (limit, cursor) => projects.list(limit, cursor),
      rename: (id, name) => changeProject(id, () => projects.rename(id, name)),
      setColor: (id, color) =>
        changeProject(id, () => projects.setColor(id, color)),
      terminate: (id) =>
        exclusive(id, async () => {
          const runtime = runtimes.get(id);
          if (runtime !== undefined) return endProject(runtime);
          // A Project with no runtime has not been resumed; build one under the
          // creation lock so a shutting-down host can never add it after
          // disposal set its flag.
          return exclusive('creation', async () => {
            if (disposed) return projects.record(id);
            const record = await projects.record(id);
            if (record === undefined || isTerminal(record.state)) return record;
            const loaded = await runtimeFromStored(id);
            return loaded === undefined ? record : endProject(loaded);
          });
        }),
      delete: (id) =>
        exclusive(id, async () => {
          const values = await threads.listByProject(id);
          const outcome = await projects.delete(id);
          if (outcome === 'deleted') {
            for (const thread of values) publisher.threadDeleted(id, thread.id);
            publisher.projectDeleted(id);
            runtimes.delete(id);
            // The record is gone; the workspace volume is discarded with it. A
            // failure to discard is logged and never fails the deletion.
            await discardWorkspace(id).catch(() => {
              logger.error(
                { projectId: id },
                'Project workspace discard failed',
              );
            });
          }
          return outcome;
        }),
      ssh,
      files,
      file,
      tree,
      diff,
      changes,
      fileDiff,
    },
    threads: {
      queue: async (id) => {
        const record = await threads.record(id);
        return record === undefined
          ? undefined
          : exclusive(record.projectId, () => threads.queue(id));
      },
      resumeQueue: async (id) => {
        const record = await threads.record(id);
        if (record === undefined) return { status: 'missing' };
        if (isTerminal(record.state)) return { status: 'inactive' };
        const project = await projectFor(record.projectId);
        const thread = project?.threads.get(id);
        if (project === undefined || thread === undefined)
          return { status: 'inactive' };
        await applyCurrentGit(project);
        return exclusive(record.projectId, () =>
          runner.resumeQueue(project, thread),
        );
      },
      queuedPrompt: async (id, promptId) => {
        const record = await threads.record(id);
        if (
          record === undefined ||
          isTerminal(record.state) ||
          record.state === 'cancelling'
        )
          return undefined;
        return exclusive(record.projectId, async () => {
          const prompt = (await threads.unfinishedPrompts(id)).find(
            (entry) => entry.promptId === promptId && !entry.superseded,
          );
          return prompt === undefined ? undefined : queuedPrompt(prompt);
        });
      },
      editQueued: async (id, promptId, text, revision) => {
        const record = await threads.record(id);
        if (record === undefined) return { status: 'missing' };
        if (isTerminal(record.state)) return { status: 'inactive' };
        const project = await projectFor(record.projectId);
        const thread = project?.threads.get(id);
        if (project === undefined || thread === undefined)
          return { status: 'inactive' };
        return exclusive(record.projectId, () =>
          runner.editQueued(project, thread, promptId, text, revision),
        );
      },
      removeQueued: async (id, promptId) => {
        const record = await threads.record(id);
        if (record === undefined) return 'missing';
        const project = await projectFor(record.projectId);
        const thread = project?.threads.get(id);
        if (project === undefined || thread === undefined) return 'inactive';
        return exclusive(record.projectId, () =>
          runner.removeQueued(project, thread, promptId),
        );
      },
      usage: async (id) => {
        const usage = await threads.usage(id);
        return usage === undefined
          ? undefined
          : withContextCapacity(usage, config.current());
      },
      create: (projectId, name, parentThreadId) =>
        exclusive(projectId, async () => {
          const runtime = runtimes.get(projectId);
          if (runtime === undefined)
            return {
              status:
                (await projects.record(projectId)) === undefined
                  ? ('missing' as const)
                  : ('inactive' as const),
            };
          return runner.create(runtime, name, parentThreadId);
        }),
      find: (id) => threads.record(id),
      list: async (projectId, limit, cursor, parentThreadId) =>
        (await projects.record(projectId)) === undefined
          ? undefined
          : threads.list(projectId, limit, cursor, parentThreadId),
      rename: async (id, name) => {
        const record = await threads.record(id);
        if (record === undefined) return undefined;
        return exclusive(record.projectId, async () => {
          const value = await threads.rename(id, name);
          if (value !== undefined) {
            const runtime = runtimes.get(record.projectId)?.threads.get(id);
            if (runtime !== undefined) runtime.thread = value;
            publisher.threadUpdated(value);
          }
          return value;
        });
      },
      setCwd: async (id, cwd) => {
        const record = await threads.record(id);
        if (record === undefined) return { status: 'missing' };
        const project = runtimes.get(record.projectId);
        const thread = project?.threads.get(id);
        if (project === undefined || thread === undefined)
          return { status: 'inactive' };
        return runner.setCwd(project, thread, cwd);
      },
      branches: async (id, branch, cwd) => {
        const record = await threads.record(id);
        if (!record) return { status: 'missing' };
        return exclusive(record.projectId, async () => {
          const project = runtimes.get(record.projectId);
          const thread = project?.threads.get(id);
          const sandbox = project?.lease?.sandbox;
          if (!project || project.closing || !thread || thread.closing)
            return { status: 'inactive' as const };
          if (!sandbox) return { status: 'pending' as const };
          // Holding the project mutation queue prevents a new prompt from racing the switch.
          if (
            branch !== undefined &&
            cwd !== undefined &&
            cwd !== thread.thread.cwd
          )
            return {
              status: 'refused' as const,
              message:
                'The working directory changed. Reopen the branch picker and try again.',
            };
          const git = await threadGit(sandbox, thread.thread.cwd);
          const paths = [
            ...[...project.threads.values()]
              .filter(
                (item) => item.active !== undefined || item.jobs.length > 0,
              )
              .map((item) => item.thread.cwd),
            ...terminals
              .list(record.projectId)
              .filter(
                (item) =>
                  item.state !== 'exited' &&
                  (item.origin === 'agent' || item.command !== 'bash'),
              )
              .map((item) => item.cwd),
          ];
          const active = await Promise.all(
            [...new Set(paths)].map((cwd) => threadGit(sandbox, cwd)),
          );
          const busy =
            git.repo &&
            active.some((item) => item.repo && item.root === git.root);
          const blocked = busy
            ? 'Wait for active prompts and terminal commands in this worktree to finish before switching branches.'
            : undefined;
          if (branch !== undefined) {
            if (blocked)
              return { status: 'refused' as const, message: blocked };
            return switchBranch(sandbox, thread.thread.cwd, branch);
          }
          const value = await readBranches(sandbox, thread.thread.cwd);
          return {
            status: 'ready' as const,
            value: { ...value, blocked: blocked ?? value.blocked },
          };
        });
      },
      git: async (id) => {
        const record = await threads.record(id);
        if (record === undefined) return { status: 'missing' };
        const project = runtimes.get(record.projectId);
        const thread = project?.threads.get(id);
        const sandbox = project?.lease?.sandbox;
        if (
          project === undefined ||
          project.closing ||
          thread === undefined ||
          thread.closing
        )
          return { status: 'inactive' };
        if (sandbox === undefined) return { status: 'pending' };
        return {
          status: 'ready',
          git: await runner.git(project, thread, sandbox),
        };
      },
      prompt: async (id, prompt) => {
        const record = await threads.record(id);
        if (record === undefined) return { status: 'missing' };
        // New input also brings a Project back if boot has not reached it yet:
        // acquire its sandbox first, then enqueue the prompt as usual. A lease
        // that cannot be acquired ends the Project, so the prompt is answered as
        // inactive exactly as a prompt to a failed Project is.
        const project = await projectFor(record.projectId);
        if (project === undefined) return { status: 'inactive' };
        // New input is the point where a live sandbox catches up with a rotated
        // or newly saved credential, before the prompt is enqueued.
        await applyCurrentGit(runtimes.get(record.projectId));
        return exclusive(record.projectId, async () => {
          const current = runtimes.get(record.projectId);
          const thread = current?.threads.get(id);
          if (current === undefined || thread === undefined)
            return { status: 'inactive' as const };
          return runner.enqueue(current, thread, prompt, { kind: 'user' });
        });
      },
      resume: async (id, promptId) => {
        const record = await threads.record(id);
        if (record === undefined) return { status: 'missing' };
        // Only work that has not finished can be taken up; anything else is not
        // this Thread's unfinished prompt.
        if (isTerminal(record.state)) return { status: 'inactive' };
        if (
          !(await threads.unfinishedPrompts(id)).some(
            (prompt) => prompt.promptId === promptId && !prompt.superseded,
          )
        )
          return { status: 'unknown_prompt' };
        const project = await projectFor(record.projectId);
        if (project === undefined) return { status: 'inactive' };
        const thread = project.threads.get(id);
        if (thread === undefined) return { status: 'inactive' };
        await applyCurrentGit(project);
        return exclusive(record.projectId, async () => {
          // Acquisition and credential refresh can outlive the run we read.
          const progress = (await threads.unfinishedPrompts(id)).find(
            (prompt) => prompt.promptId === promptId && !prompt.superseded,
          );
          if (progress === undefined)
            return { status: 'unknown_prompt' as const };
          if (thread.thread.queuePaused)
            return runner.resumeQueue(project, thread, promptId);
          return runner.resume(
            project,
            thread,
            jobFor(progress),
            progress.attempts + 1,
          );
        });
      },
      rewind: async (id, promptId, prompt) => {
        const record = await threads.record(id);
        if (record === undefined) return { status: 'missing' };
        // A rewind enqueues its replacement input the same way a prompt does.
        await applyCurrentGit(runtimes.get(record.projectId));
        return exclusive(record.projectId, async () => {
          const project = runtimes.get(record.projectId);
          const thread = project?.threads.get(id);
          if (project === undefined || thread === undefined)
            return { status: 'inactive' as const };
          return runner.rewind(project, thread, promptId, prompt);
        });
      },
      events: async (id, afterSequence) => {
        const record = await threads.record(id);
        if (record === undefined) return undefined;
        const events = await threads.eventsAfter(id, afterSequence);
        return {
          events,
          lastSequence: Math.max(
            record.lastSequence,
            events.at(-1)?.sequence ?? 0,
          ),
        };
      },
      interrupt: async (id, _promptId) => {
        const record = await threads.record(id);
        if (record === undefined) return 'missing';
        return exclusive(record.projectId, async () => {
          const thread = runtimes.get(record.projectId)?.threads.get(id);
          return Promise.resolve(
            thread === undefined
              ? 'inactive'
              : // The reader's own stop pauses the run, so the reader can take it
                // up again; a parent Thread's tool stops a child outright.
                runner.pause(thread),
          );
        });
      },
      terminate: async (id) => {
        const record = await threads.record(id);
        if (record === undefined) return undefined;
        return exclusive(record.projectId, async () => {
          const project = runtimes.get(record.projectId);
          if (project !== undefined) {
            await runner.close(project, runner.descendants(project, id));
            return project.threads.get(id)?.thread ?? record;
          }
          return terminateStored(record.projectId, id);
        });
      },
      delete: async (id) => {
        const record = await threads.record(id);
        if (record === undefined) return 'missing';
        return exclusive(record.projectId, async () => {
          const values = await threads.listByProject(record.projectId);
          const ids = subtreeIds(values, id);
          const outcome = await threads.deleteSubtree(id);
          if (outcome === 'deleted')
            for (const child of ids) {
              runtimes.get(record.projectId)?.threads.delete(child);
              publisher.threadDeleted(record.projectId, child);
            }
          return outcome;
        });
      },
    },
    /**
     * Takes up the prompts the host owes a run before anyone asks for one: work
     * the reader asked for and a host interruption left unfinished, and work a
     * crash left accepted but never started. These Projects acquire before the
     * idle Projects in recoverProjects. Their prompts are re-enqueued in the
     * order the log accepted them, opening the
     * next attempt of each one — until a prompt has been taken up as often as the
     * budget allows, which is closed as a failure instead, so a host that keeps
     * dying on the same prompt stops circling it.
     */
    resumeInterrupted: async () => {
      const paused = new Set<string>();
      const unfinished = await threads.unfinishedPrompts();
      for (const id of new Set(unfinished.map((prompt) => prompt.threadId)))
        if ((await threads.record(id))?.queuePaused) paused.add(id);
      const owed = unfinished.filter(
        (prompt) => hostOwesRun(prompt) && !paused.has(prompt.threadId),
      );
      for (const prompt of owed) {
        if (resumeExhausted(prompt))
          await threads.failPrompt(prompt, resumeExhaustedError);
      }
      // Closing a delegated prompt can accept a result for its parent in the
      // same transaction. Include that new work in this boot's queue.
      const pending = new Map<string, PromptProgress[]>();
      for (const prompt of (await threads.unfinishedPrompts()).filter(
        (prompt) => hostOwesRun(prompt) && !paused.has(prompt.threadId),
      )) {
        // Exhausting a child can deliver the first pending input to a paused parent.
        if ((await threads.record(prompt.threadId))?.queuePaused) continue;
        const group = pending.get(prompt.projectId);
        if (group === undefined) pending.set(prompt.projectId, [prompt]);
        else group.push(prompt);
      }
      let resumed = 0;
      for (const [projectId, prompts] of pending) {
        const runtime = await resumeProject(projectId);
        if (runtime === undefined) continue;
        // Queue before the listener opens. Acquisition starts the runner when a
        // lease is ready; waiting here would block boot when capacity is full.
        for (const prompt of prompts) {
          const thread = runtime.threads.get(prompt.threadId);
          if (thread === undefined || runtime.closing) continue;
          const outcome = await exclusive(projectId, () =>
            runner.resume(runtime, thread, jobFor(prompt), prompt.attempts + 1),
          );
          if (outcome.status === 'resumed') resumed += 1;
        }
      }
      return resumed;
    },
    recoverProjects: async () => {
      let cursor: string | undefined;
      do {
        const page = await projects.list(100, cursor);
        for (const project of page.items) {
          if (!isTerminal(project.state) && project.state !== 'cancelling')
            await resumeProject(project.id);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined && !disposed);
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
      await exclusive('creation', () => {
        disposed = true;
        return Promise.resolve();
      });
      const values = [...runtimes.values()];
      await Promise.all(
        values.map((runtime) =>
          exclusive(runtime.project.id, () => {
            suspendProject(runtime);
            return Promise.resolve();
          }),
        ),
      );
      await Promise.all(
        values.map((runtime) => Promise.resolve(runtime.ending)),
      );
    },
  };
};
