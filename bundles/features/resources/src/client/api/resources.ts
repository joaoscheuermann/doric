// The window's calls to `resources/v1` over Connect, as the layout's
// provisional adapter made them (moved, §3.12):
//
// 1. the main process's identifier guard, with its message;
// 2. the host outcome, read back from `ResourcesService`'s messages as what the
//    REST client answered for the route's status (a lease state stays data,
//    `pending` with `Retry-After: 1`);
// 3. a failed call is an `Error` with the message the REST path showed; a
//    `ConnectError` reads as its Doric error.
//
// Slice S65d: the host is `ResourcesService`'s generated client over Connect.

import { ConnectError } from '@connectrpc/connect';
import {
  type ClientServices,
  ContractError,
  fromConnectError,
  isContractError,
  type Services,
} from 'bundle/contracts';
import { decode } from 'runtime/contracts';

import {
  HostResponseSchema,
  ProjectResponseSchema,
  ResourcesService,
} from '../../contracts/gen/doric/resources/v1/resources_pb.js';
import {
  type ContainerResources,
  containerResourcesSchema,
  type HostResources,
  hostResourcesSchema,
  type Resources,
} from '../../contracts/index.js';
import type { ProjectResourcesResult } from '../domain/resources.js';

export const resourcesMessages = {
  unavailable: 'Doric backend is unavailable.',
  invalidResponse: 'Doric returned an invalid response.',
  /** The REST 500 envelope: any other host failure. */
  failed: 'The request could not be completed.',
  invalidIdentifier: 'The item identifier is invalid.',
} as const;

const invalidResponse = (): never => {
  throw new ContractError(
    'invalid_output',
    `${resourcesMessages.invalidResponse}`,
  );
};

/** `value` parsed by `schema`, or `invalid_output`. */
const containerOf = (value: unknown): ContainerResources => {
  const parsed = containerResourcesSchema.safeParse(value);
  if (!parsed.success) return invalidResponse();
  return parsed.data;
};

/** The message a failed host call shows, as the REST path showed it. */
const hostFailure = (error: unknown): Error => {
  if (isContractError(error)) {
    if (
      error.code === 'unavailable' ||
      error.code === 'disconnected' ||
      error.code === 'generation_lost'
    ) {
      return new Error(resourcesMessages.unavailable);
    }
    if (error.code === 'invalid_output') {
      return new Error(resourcesMessages.invalidResponse);
    }
  }
  return new Error(resourcesMessages.failed);
};

const call = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    throw hostFailure(
      error instanceof ConnectError ? fromConnectError(error) : error,
    );
  }
};

const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new Error(resourcesMessages.invalidIdentifier);
  }
  return value;
};

const leaseStatuses = ['pending', 'unavailable', 'expired', 'missing'] as const;

/** The monitor's two reads. */
export interface ResourcesReads {
  host(): Promise<HostResources>;
  project(projectId: string): Promise<ProjectResourcesResult>;
}

/**
 * The reads over `resources/v1`, where `resources(projectId)` is the
 * contract bound to that Project's scope (no Project for the host read).
 */
export const createResourcesReads = (
  resources: (projectId?: string) => Resources,
): ResourcesReads => ({
  host: () => call(() => resources().host()),
  project: async (projectId) => {
    const id = identifier(projectId);
    const result = await call(() => resources(id).project());
    if (result.status === 'ready') {
      return { status: 'ready', container: result.value };
    }
    return result.status === 'pending'
      ? { status: 'pending', retryAfterSeconds: 1 }
      : { status: result.status };
  },
});

/**
 * `resources/v1` over `ResourcesService`'s generated client, in today's shape:
 * scoped to the Project when one is given, no scope for the machine.
 */
export const resourcesHostOf = (
  services: Services,
): ((projectId?: string) => Resources) => {
  const resources = (projectId?: string): Resources => {
    const client = (services as ClientServices).use(
      ResourcesService,
      projectId === undefined ? undefined : { projectId },
    );

    return {
      host: async () => {
        const message = await client.host({});
        const parsed = hostResourcesSchema.safeParse(
          decode(HostResponseSchema, message),
        );
        if (!parsed.success) return invalidResponse();
        return parsed.data;
      },
      project: async () => {
        const message = await client.project({});
        const answer = decode(ProjectResponseSchema, message) as {
          readonly status?: unknown;
          readonly value?: unknown;
        };
        if (answer.status === 'ready') {
          return { status: 'ready', value: containerOf(answer.value) };
        }
        if (
          typeof answer.status !== 'string' ||
          !(leaseStatuses as readonly string[]).includes(answer.status)
        ) {
          return invalidResponse();
        }
        return { status: answer.status as (typeof leaseStatuses)[number] };
      },
    };
  };

  return resources;
};
