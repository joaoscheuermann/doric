// The window's writes to `files/v1` (1.2.0, §4.4 A9, A10): New file and New
// folder, beside the reads (`reads.ts`). Each answers the method's outcome
// unchanged; the name row that calls them maps every outcome to its text
// ("Non-success answers in the UI"), and a call that throws stays a throw.
//
// Slice S65d: the host is `FilesService`'s generated client over Connect, so
// each outcome is read back from its message; a `ConnectError` reads as its
// Doric error (`fromConnectError`).

import { type Client, ConnectError } from '@connectrpc/connect';
import {
  type ClientServices,
  fromConnectError,
  type Services,
} from 'bundle/contracts';

import {
  type CreateDirectoryResponse,
  type CreateFileResponse,
  FilesService,
} from '../../contracts/gen/doric/files/v1/files_pb.js';
import type { CreateOutcome, LeaseOutcome } from '../../contracts/index.js';

export const writeMessages = {
  invalidResponse: 'Doric returned an invalid response.',
} as const;

const invalidResponse = (): never => {
  throw new Error(writeMessages.invalidResponse);
};

/** A failed call stays a throw, as today: its Doric error for a `ConnectError`. */
const call = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof ConnectError ? fromConnectError(error) : error;
  }
};

const leaseStatuses = ['pending', 'unavailable', 'expired', 'missing'] as const;

const refusalReasons = [
  'exists',
  'invalid-name',
  'outside',
  'no-directory',
] as const;

type LeaseStatus = (typeof leaseStatuses)[number];

/** A pending lease, as the REST client read it: `Retry-After: 1`. */
const pending = { status: 'pending' as const, retryAfterSeconds: 1 };

const createOutcomeFrom = (value: unknown): LeaseOutcome<CreateOutcome> => {
  if (typeof value !== 'object' || value === null) return invalidResponse();
  const outcome = value as {
    readonly status?: unknown;
    readonly path?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
  };
  if (outcome.status === 'created') {
    if (typeof outcome.path !== 'string') return invalidResponse();
    return {
      status: 'ready',
      value: { status: 'created', path: outcome.path },
    };
  }
  if (outcome.status === 'refused') {
    if (
      typeof outcome.reason !== 'string' ||
      !(refusalReasons as readonly string[]).includes(outcome.reason)
    ) {
      return invalidResponse();
    }
    return {
      status: 'ready',
      value: {
        status: 'refused',
        reason: outcome.reason as (typeof refusalReasons)[number],
      },
    };
  }
  if (outcome.status === 'failed') {
    if (typeof outcome.message !== 'string') return invalidResponse();
    return {
      status: 'ready',
      value: { status: 'failed', message: outcome.message },
    };
  }
  return invalidResponse();
};

/** A write response as today's lease outcome: `ready` carries the outcome. */
const writeOutcome = (
  response: CreateFileResponse | CreateDirectoryResponse,
): LeaseOutcome<CreateOutcome> => {
  if (response.status !== 'ready') {
    if (!(leaseStatuses as readonly string[]).includes(response.status)) {
      return invalidResponse();
    }
    const status = response.status as LeaseStatus;
    return status === 'pending' ? pending : { status };
  }
  if (response.value === undefined) return invalidResponse();
  return createOutcomeFrom(response.value);
};

export interface FilesWrites {
  /** Creates the empty file `name` in `directory` of the Project. */
  createFile(
    projectId: string,
    directory: string,
    name: string,
  ): Promise<LeaseOutcome<CreateOutcome>>;
  /** Creates the empty directory `name` in `directory` of the Project. */
  createDirectory(
    projectId: string,
    directory: string,
    name: string,
  ): Promise<LeaseOutcome<CreateOutcome>>;
}

/** The `FilesService` calls the writes make. */
export type FilesWriteCalls = Pick<
  Client<typeof FilesService>,
  'createFile' | 'createDirectory'
>;

/** The writes over `FilesService`, each scoped to its Project. */
export const createFilesWrites = (
  files: (projectId: string) => FilesWriteCalls,
): FilesWrites => ({
  createFile: async (projectId, directory, name) =>
    writeOutcome(
      await call(() => files(projectId).createFile({ directory, name })),
    ),
  createDirectory: async (projectId, directory, name) =>
    writeOutcome(
      await call(() => files(projectId).createDirectory({ directory, name })),
    ),
});

/** The writes bound to a part's services: `FilesService` over Connect, scoped to the Project. */
export const filesWritesOf = (services: Services): FilesWrites =>
  createFilesWrites((projectId) =>
    (services as ClientServices).use(FilesService, { projectId }),
  );
