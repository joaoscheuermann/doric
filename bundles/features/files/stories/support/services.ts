// A stand-in for the `Services` a files element receives: every contract the
// story serves is available at once, keyed by its contract id, so the
// components read seeded fixtures instead of a live host. `use` answers the
// same API whatever the scope, or the API a scoped factory builds for it. A
// many-contract is served by several providers, each under its bundle id.
//
// Since S65d a client part asks for the generated `FilesService` descriptor
// rather than the `files/v1` contract id. A descriptor resolves to its
// contract id (`getOption(file, contractOption).id`) and answers the `Files`
// fixture written as the generated client, each answer encoded by the host's
// codec, so a story keeps describing today's `Files` API.

import {
  create,
  type DescService,
  getOption,
  hasOption,
} from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import type {
  AnyServiceRef,
  ApiOf,
  CallScope,
  Disposable,
  Services,
} from 'bundle/contracts';
import { contract as contractOption } from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import type { Project, Thread } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';

import {
  type ContentRequest,
  ContentResponseSchema,
  type CreateDirectoryRequest,
  CreateDirectoryResponseSchema,
  type CreateFileRequest,
  CreateFileResponseSchema,
  type DirectoriesRequest,
  DirectoriesResponseSchema,
  type DirectoryRequest,
  DirectoryResponseSchema,
  type FilesService,
  type ReadBytesRequest,
  type TreeRequest,
  TreeResponseSchema,
} from '../../src/contracts/gen/doric/files/v1/files_pb.js';
import type { Files } from '../../src/contracts/index.js';
import {
  contentResponseOf,
  createDirectoryResponseOf,
  createFileResponseOf,
  directoriesResponseOf,
  directoryResponseOf,
  treeResponseOf,
} from '../../src/host/codec.js';

type Provided = unknown | ((scope: CallScope | undefined) => unknown);

const disposed: Disposable = { dispose: () => undefined };

const provider = { bundleId: 'stories', version: '0.0.0' };

/** One provider of a many-contract: the bundle that provides it, and its API. */
export interface StoryProvider {
  readonly bundleId: string;
  readonly api: unknown;
}

/** A generated service descriptor, as `use` tells it from a `ref`. */
const isDescService = (value: unknown): value is DescService =>
  typeof value === 'object' &&
  value !== null &&
  (value as { readonly kind?: unknown }).kind === 'service' &&
  typeof (value as { readonly typeName?: unknown }).typeName === 'string';

/** The contract id a `ref` or a generated service descriptor declares. */
const contractIdOf = (contract: unknown): string | undefined => {
  if (isDescService(contract)) {
    return hasOption(contract.file, contractOption)
      ? getOption(contract.file, contractOption).id
      : undefined;
  }
  return (contract as { readonly id?: string } | undefined)?.id;
};

/** A workspace path as today's input: the root sends no path. */
const pathOf = (path: string | undefined): { readonly path?: string } =>
  path === undefined || path === '' ? {} : { path };

/**
 * `files/v1` as today's `Files` fixture answers it, over the generated client
 * a client part reaches: each request becomes today's input, and the host's
 * codec writes each answer. A method the fixture leaves out refuses.
 */
const filesClientOf = (api: Partial<Files>): Client<typeof FilesService> => {
  const notServed = (): Promise<never> =>
    Promise.reject(new Error('Not this story\u2019s call.'));

  return {
    directory: async (request: DirectoryRequest) =>
      api.directory === undefined
        ? notServed()
        : create(
            DirectoryResponseSchema,
            directoryResponseOf(await api.directory(pathOf(request.path))),
          ),
    tree: async (request: TreeRequest) =>
      api.tree === undefined
        ? notServed()
        : create(
            TreeResponseSchema,
            treeResponseOf(await api.tree(pathOf(request.path))),
          ),
    directories: async (request: DirectoriesRequest) =>
      api.directories === undefined
        ? notServed()
        : create(
            DirectoriesResponseSchema,
            directoriesResponseOf(
              await api.directories({
                paths: request.paths,
                ...(request.root === undefined ? {} : { root: request.root }),
              }),
            ),
          ),
    content: async (request: ContentRequest) =>
      api.content === undefined
        ? notServed()
        : create(
            ContentResponseSchema,
            contentResponseOf(await api.content({ path: request.path })),
          ),
    readBytes: (_request: ReadBytesRequest) => ({
      [Symbol.asyncIterator]: () => ({ next: notServed }),
    }),
    createFile: async (request: CreateFileRequest) =>
      api.createFile === undefined
        ? notServed()
        : create(
            CreateFileResponseSchema,
            createFileResponseOf(
              await api.createFile({
                directory: request.directory,
                name: request.name,
              }),
            ),
          ),
    createDirectory: async (request: CreateDirectoryRequest) =>
      api.createDirectory === undefined
        ? notServed()
        : create(
            CreateDirectoryResponseSchema,
            createDirectoryResponseOf(
              await api.createDirectory({
                directory: request.directory,
                name: request.name,
              }),
            ),
          ),
  } as unknown as Client<typeof FilesService>;
};

/**
 * Services over fixed APIs. A value that is a function receives the call's
 * scope and returns the API for it (`services.use(FilesV1, { projectId })`);
 * pass such APIs under `scoped`. A contract under `many` has one provider per
 * entry: `whenAvailable` calls back once for each, in the order given, with
 * its bundle id, and disposing the binding runs every cleanup.
 */
export const storyServices = ({
  apis = {},
  scoped = {},
  many = {},
}: {
  readonly apis?: Readonly<Record<string, unknown>>;
  readonly scoped?: Readonly<
    Record<string, (scope: CallScope | undefined) => unknown>
  >;
  readonly many?: Readonly<Record<string, readonly StoryProvider[]>>;
}): Services => {
  /** The API a contract answers: a descriptor's `files/v1` fixture as a client. */
  const apiOf = (contract: unknown, scope?: CallScope): Provided => {
    const id = contractIdOf(contract);
    if (id === undefined) return undefined;
    const factory = scoped[id];
    const api = factory === undefined ? apis[id] : factory(scope);
    return isDescService(contract) && id === 'files/v1' && api !== undefined
      ? filesClientOf(api as Partial<Files>)
      : api;
  };

  return {
    provide: () => disposed,
    use: <R extends AnyServiceRef>(contract: R, scope?: CallScope) => {
      const api = apiOf(contract, scope);
      if (api === undefined) {
        throw new Error(
          `The story does not serve ${contractIdOf(contract) ?? 'this contract'}.`,
        );
      }
      return api as ApiOf<R>;
    },
    whenAvailable: (contract, callback) => {
      const id = contractIdOf(contract);
      const providers = id === undefined ? undefined : many[id];
      if (providers !== undefined) {
        const cleanups = providers.map(({ bundleId, api }) =>
          callback(api as never, { bundleId, version: provider.version }),
        );
        return {
          dispose: () => {
            for (const cleanup of cleanups) {
              if (typeof cleanup === 'function') void cleanup();
            }
          },
        };
      }
      const api = apiOf(contract);
      if (api === undefined) return disposed;
      const cleanup = callback(api as never, provider);
      return {
        dispose: () => {
          if (typeof cleanup === 'function') void cleanup();
        },
      };
    },
  };
};

/** A `subscribe(listener): Disposable` source whose snapshot never changes. */
export const still = { subscribe: () => disposed };

/**
 * `workspace.selection/v1` on `project` and `thread` (either may be absent)
 * and `runtime.records/v1` holding them, primed so it answers the Thread.
 */
export const selectionApis = (selection: {
  readonly project?: Project;
  readonly thread?: Thread;
}): Readonly<Record<string, unknown>> => {
  const { project, thread } = selection;
  const ids = {
    ...(project === undefined ? {} : { projectId: project.id }),
    ...(thread === undefined ? {} : { threadId: thread.id }),
  };
  const records = createRecordsApi({
    projects: project === undefined ? [] : [project],
    threads: thread === undefined ? [] : [thread],
  });
  // The records answer a Thread of a described Project only.
  if (thread !== undefined) records.threads(thread.projectId);
  return {
    'workspace.selection/v1': { ...still, current: () => ids },
    'runtime.records/v1': records,
  };
};
