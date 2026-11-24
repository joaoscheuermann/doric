import type { ProjectFileDiff } from 'git/contracts';
import type { ContainerResources } from 'resources/contracts';
import {
  conflictError,
  notFoundError,
  type Project,
  type ProjectLeaseState,
  type ProjectSsh,
  projectColors,
  type Runtime,
  type Thread,
  type ThreadPage,
} from 'runtime/contracts';
import { z } from 'zod';

import { nameInput, ok, pageInput, refused } from '../../routes/input.js';
import type { ApiAnswer, RouteInput } from '../answer.js';
import type { TransportPorts } from '../ports.js';

type Op<V> = (input: RouteInput) => Promise<ApiAnswer<V>>;

/** One page of Projects as `GET /projects` answers it. */
export type ProjectPage = Awaited<ReturnType<Runtime['projects']>>;

/** The ready SSH access of a Project's lease. */
export type ProjectSshReady = Extract<ProjectSsh, { readonly status: 'ready' }>;

const projectInput = z.object({ name: nameInput }).strict();
const projectColorInput = z
  .object({ color: z.enum([...projectColors]).nullable() })
  .strict();
const createInput = z
  .object({ name: nameInput, parentThreadId: z.uuid().optional() })
  .strict();
const threadsInput = pageInput.extend({ parentThreadId: z.uuid().optional() });
const pathInput = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\u0000'));
const pathQuery = z.object({ path: pathInput.optional() });
/** An optional query path as a lease read takes it: absent stays absent. */
const pathOf = (path: string | undefined) =>
  path === undefined ? {} : { path };

const invalidProject = refused({
  status: 422,
  code: 'invalid_project',
  message: 'A Project name between 1 and 80 characters is required.',
});
const invalidPage = refused({
  status: 400,
  code: 'invalid_page',
  message: 'The page is invalid.',
});
const invalidPath = refused({
  status: 422,
  code: 'invalid_project_path',
  message: 'The Project path is invalid.',
});
const pathNotFound = refused({
  status: 404,
  code: 'project_path_not_found',
  message: 'The Project path was not found.',
});
const projectMissing = refused(notFoundError('project'));

/** The lease-dependent statuses every Project file subresource reports. */
const leaseStates = new Set<ProjectLeaseState>([
  'missing',
  'pending',
  'unavailable',
  'expired',
]);

/** The answer of a lease status other than `ready` (today's `leaseResponse`). */
const leaseAnswer = (status: string): ApiAnswer<never> => {
  if (status === 'missing') return projectMissing;
  if (status === 'pending') return { kind: 'pending' };
  if (status === 'expired') {
    return refused({
      status: 410,
      code: 'project_files_expired',
      message: 'The Project file access has expired.',
    });
  }
  return refused(conflictError('project', 'files_unavailable'));
};

/** The answer of a directory or tree read. */
const listing = (
  outcome: Awaited<
    ReturnType<ReturnType<TransportPorts['files']>['directory']>
  >,
): ApiAnswer<{
  readonly path: string;
  readonly entries: readonly unknown[];
}> => {
  if (outcome.status !== 'ready') return leaseAnswer(outcome.status);
  const result = outcome.value;
  if (result.status === 'listed') {
    return ok({ path: result.path, entries: result.entries });
  }
  if (result.status === 'not_found') return pathNotFound;
  return refused({
    status: 422,
    code: 'invalid_project_path',
    message: 'The Project path is not a directory.',
  });
};

/**
 * The `/projects` route bodies over the ports. Project creation reserves an
 * environment; conversations are created separately. The file, Git and
 * resource reads call the `files`, `git` and `resources` bundles (stage 10
 * §4), which answer the lease state as data.
 */
export const projectOperations = ({
  runtime,
  threads,
  lease,
  files,
  git,
  resources,
}: Pick<
  TransportPorts,
  'runtime' | 'threads' | 'lease' | 'files' | 'git' | 'resources'
>): {
  /** `POST /projects` → 202. */
  readonly create: Op<Project & { readonly ssh: { readonly href: string } }>;
  /** `GET /projects`. */
  readonly list: Op<ProjectPage>;
  /** `GET /projects/:id`. */
  readonly get: Op<Project>;
  /** `PATCH /projects/:id`. */
  readonly rename: Op<Project>;
  /** `PATCH /projects/:id/color`. */
  readonly setColor: Op<Project>;
  /** `POST /projects/:id/threads` → 201. */
  readonly createThread: Op<Thread>;
  /** `GET /projects/:id/threads`. */
  readonly listThreads: Op<ThreadPage>;
  /** `GET /projects/:id/ssh` (pending possible). */
  readonly ssh: Op<ProjectSshReady & { readonly href: string }>;
  /** `GET /projects/:id/files` (pending possible). */
  readonly files: Op<{
    readonly path: string;
    readonly entries: readonly unknown[];
  }>;
  /** `GET /projects/:id/tree` (pending possible). */
  readonly tree: Op<{
    readonly path: string;
    readonly entries: readonly unknown[];
  }>;
  /** `GET /projects/:id/files/content` (pending possible). */
  readonly content: Op<{
    readonly path: string;
    readonly content: string;
    readonly truncated: boolean;
    readonly binary: boolean;
  }>;
  /** `GET /projects/:id/diff` (pending possible). */
  readonly diff: Op<{
    readonly path?: string;
    readonly repositories: readonly unknown[];
  }>;
  /** `GET /projects/:id/changes` (pending possible). */
  readonly changes: Op<{
    readonly path?: string;
    readonly repositories: readonly unknown[];
  }>;
  /** `GET /projects/:id/files/diff` (pending possible). */
  readonly fileDiff: Op<ProjectFileDiff>;
  /** `GET /projects/:id/resources` (pending possible). */
  readonly resources: Op<ContainerResources>;
  /** `POST /projects/:id/terminate`. */
  readonly terminate: Op<Project>;
  /** `DELETE /projects/:id` → 204. */
  readonly remove: Op<undefined>;
} => ({
  create: async ({ body }) => {
    const input = projectInput.safeParse(body ?? {});
    if (!input.success) return invalidProject;
    const project = await runtime.createProject({ name: input.data.name });
    return ok(
      { ...project, ssh: { href: `/projects/${project.id}/ssh` } },
      202,
    );
  },
  list: async ({ query }) => {
    const input = pageInput.safeParse(query);
    if (!input.success) return invalidPage;
    return ok(
      await runtime.projects({
        limit: input.data.limit,
        ...(input.data.cursor === undefined
          ? {}
          : { cursor: input.data.cursor }),
      }),
    );
  },
  rename: async ({ params, body }) => {
    const input = projectInput.safeParse(body ?? {});
    if (!input.success) return invalidProject;
    const project = await runtime.renameProject({
      id: params.id ?? '',
      name: input.data.name,
    });
    if (project === undefined) return projectMissing;
    return ok(project);
  },
  setColor: async ({ params, body }) => {
    const input = projectColorInput.safeParse(body ?? {});
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_project_color',
        message: 'A Project color from the palette, or null, is required.',
      });
    }
    const project = await runtime.setProjectColor({
      id: params.id ?? '',
      color: input.data.color,
    });
    if (project === undefined) return projectMissing;
    return ok(project);
  },
  get: async ({ params }) => {
    const project = await runtime.project(params.id ?? '');
    if (project === undefined) return projectMissing;
    return ok(project);
  },
  createThread: async ({ params, body }) => {
    const input = createInput.safeParse(body ?? {});
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_thread',
        message:
          'A Thread name between 1 and 80 characters and optional parentThreadId are accepted.',
      });
    }
    const result = await threads.createThread({
      projectId: params.id ?? '',
      name: input.data.name,
      ...(input.data.parentThreadId === undefined
        ? {}
        : { parentThreadId: input.data.parentThreadId }),
    });
    if (result.status === 'missing') return projectMissing;
    if (result.status !== 'created') {
      return refused(conflictError('thread', result.status));
    }
    return ok(result.thread, 201);
  },
  listThreads: async ({ params, query }) => {
    const input = threadsInput.safeParse(query);
    if (!input.success) return invalidPage;
    const page = await threads.threads({
      projectId: params.id ?? '',
      limit: input.data.limit,
      ...(input.data.cursor === undefined ? {} : { cursor: input.data.cursor }),
      ...(input.data.parentThreadId === undefined
        ? {}
        : { parentThreadId: input.data.parentThreadId }),
    });
    if (page === undefined) return projectMissing;
    return ok(page);
  },
  ssh: async ({ params }) => {
    const access = await lease({ projectId: params.id ?? '' }).ssh();
    if (access.status === 'missing') return projectMissing;
    if (access.status === 'pending') return { kind: 'pending' };
    if (access.status === 'expired') {
      return refused({
        status: 410,
        code: 'project_ssh_expired',
        message: 'SSH access has expired.',
      });
    }
    if (access.status !== 'ready') {
      return refused(conflictError('project', 'ssh_unavailable'));
    }
    return ok({
      ...access,
      href: `/vms/${encodeURIComponent(access.vmId)}/ssh`,
    });
  },
  files: async ({ params, query }) => {
    const input = pathQuery.safeParse(query);
    if (!input.success) return invalidPath;
    return listing(
      await files({ projectId: params.id ?? '' }).directory(
        pathOf(input.data.path),
      ),
    );
  },
  resources: async ({ params }) => {
    const result = await resources({ projectId: params.id ?? '' }).project();
    if (result.status === 'ready') return ok(result.value);
    if (leaseStates.has(result.status as ProjectLeaseState)) {
      return leaseAnswer(result.status);
    }
    return refused(conflictError('project', 'resources_unavailable'));
  },
  tree: async ({ params, query }) => {
    const input = pathQuery.safeParse(query);
    if (!input.success) return invalidPath;
    return listing(
      await files({ projectId: params.id ?? '' }).tree(pathOf(input.data.path)),
    );
  },
  content: async ({ params, query }) => {
    const input = pathInput.safeParse(
      (query as { readonly path?: unknown }).path,
    );
    if (!input.success) return invalidPath;
    const outcome = await files({ projectId: params.id ?? '' }).content({
      path: input.data,
    });
    if (outcome.status !== 'ready') return leaseAnswer(outcome.status);
    const result = outcome.value;
    if (result.status === 'read') {
      return ok({
        path: result.path,
        content: result.content,
        truncated: result.truncated,
        binary: result.binary,
      });
    }
    if (result.status === 'not_found') return pathNotFound;
    return refused({
      status: 422,
      code: 'invalid_project_path',
      message: 'The Project path is not a readable file.',
    });
  },
  diff: async ({ params, query }) => {
    const input = pathQuery.safeParse(query);
    if (!input.success) return invalidPath;
    const outcome = await git({ projectId: params.id ?? '' }).diff(
      pathOf(input.data.path),
    );
    if (outcome.status !== 'ready') return leaseAnswer(outcome.status);
    const result = outcome.value;
    if (result.status === 'read') {
      return ok({
        ...(result.path === undefined ? {} : { path: result.path }),
        repositories: result.repositories,
      });
    }
    if (result.status === 'not_found') return pathNotFound;
    return invalidPath;
  },
  changes: async ({ params, query }) => {
    const input = pathQuery.safeParse(query);
    if (!input.success) return invalidPath;
    const outcome = await git({ projectId: params.id ?? '' }).changes(
      pathOf(input.data.path),
    );
    if (outcome.status !== 'ready') return leaseAnswer(outcome.status);
    const result = outcome.value;
    if (result.status === 'read') {
      return ok({
        ...(result.path === undefined ? {} : { path: result.path }),
        repositories: result.repositories,
      });
    }
    return refused({
      status: result.status === 'not_found' ? 404 : 422,
      code:
        result.status === 'not_found'
          ? 'project_path_not_found'
          : 'invalid_project_path',
      message: 'The Project path cannot be read.',
    });
  },
  fileDiff: async ({ params, query }) => {
    const input = z
      .object({ repository: pathInput, path: pathInput.min(1) })
      .safeParse(query);
    if (!input.success) return invalidPath;
    const outcome = await git({ projectId: params.id ?? '' }).fileDiff({
      repository: input.data.repository,
      path: input.data.path,
    });
    if (outcome.status !== 'ready') return leaseAnswer(outcome.status);
    const result = outcome.value;
    if (result.status === 'read') return ok(result.diff);
    return refused({
      status: result.status === 'not_found' ? 404 : 422,
      code:
        result.status === 'not_found'
          ? 'project_path_not_found'
          : 'invalid_project_path',
      message: 'The changed file cannot be read.',
    });
  },
  terminate: async ({ params }) => {
    const project = await runtime.terminateProject(params.id ?? '');
    if (project === undefined) return projectMissing;
    return ok(project);
  },
  remove: async ({ params }) => {
    const result = await runtime.deleteProject(params.id ?? '');
    if (result === 'missing') return projectMissing;
    if (result === 'active') {
      return refused(conflictError('project', 'active'));
    }
    return ok(undefined, 204);
  },
});
