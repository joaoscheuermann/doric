// The window's calls to `resources/v1` over the client → host bridge, as the
// layout's provisional adapter made them (moved, §3.12):
//
// 1. the main process's identifier guard, with its message;
// 2. the host outcome, turned into what the REST client answered for the
//    route's status (a lease state stays data, `pending` with `Retry-After: 1`);
// 3. a failed call is an `Error` with the message the REST path showed.

import { isContractError } from 'bundle/contracts';

import type { Resources } from '../../contracts/index.js';
import type {
  ContainerResources,
  HostResources,
  ProjectResourcesResult,
} from '../domain/resources.js';

export const resourcesMessages = {
  unavailable: 'Doric backend is unavailable.',
  invalidResponse: 'Doric returned an invalid response.',
  /** The REST 500 envelope: any other host failure. */
  failed: 'The request could not be completed.',
  invalidIdentifier: 'The item identifier is invalid.',
} as const;

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
    throw hostFailure(error);
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const containerResourcesFrom = (value: unknown): ContainerResources => {
  if (
    !isRecord(value) ||
    (value.status !== 'ready' && value.status !== 'unavailable') ||
    typeof value.at !== 'string' ||
    (value.cpuPercent !== undefined && typeof value.cpuPercent !== 'number') ||
    (value.cpuCount !== undefined && typeof value.cpuCount !== 'number') ||
    (value.memoryUsedBytes !== undefined &&
      typeof value.memoryUsedBytes !== 'number') ||
    (value.memoryLimitBytes !== undefined &&
      typeof value.memoryLimitBytes !== 'number')
  ) {
    throw new Error(resourcesMessages.invalidResponse);
  }
  return value as ContainerResources;
};

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
      return {
        status: 'ready',
        container: containerResourcesFrom(result.value),
      };
    }
    return result.status === 'pending'
      ? { status: 'pending', retryAfterSeconds: 1 }
      : { status: result.status };
  },
});
