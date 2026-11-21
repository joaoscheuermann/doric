// The window services `<resources-monitor>` reads: `workspace.selection/v1`
// for the selected Project, `runtime.records/v1` for the connection and
// `resources/v1` for the readings, all over fixtures.

import type { Services } from 'bundle/contracts';
import type { RuntimeRecords } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';

import type {
  HostResources,
  ProjectResourcesResult,
} from '../../src/client/domain/resources.js';
import type { Resources } from '../../src/contracts/index.js';
import {
  containerReading,
  hostReading,
  projectId,
  readyProject,
} from './resources.js';
import { fakeServices } from './services.js';

/** The part of `workspace.selection/v1` the monitor reads. */
export interface FixtureSelection {
  current(): { readonly projectId?: string };
  subscribe(listener: () => void): { dispose(): void };
}

/**
 * A selection that holds one Project and never changes. `subscribe` never
 * notifies.
 */
export const fixtureSelection = (
  selectedProjectId: string | undefined = projectId,
): FixtureSelection => ({
  current: () =>
    selectedProjectId === undefined ? {} : { projectId: selectedProjectId },
  subscribe: () => ({ dispose: () => undefined }),
});

/** `resources/v1` as its host answers: the Project's read is a lease outcome. */
const fixtureResources = (input: {
  readonly host: () => HostResources;
  readonly project: () => ProjectResourcesResult;
}): Resources => ({
  host: () => Promise.resolve(input.host()),
  project: () => {
    const result = input.project();
    return Promise.resolve(
      result.status === 'ready'
        ? { status: 'ready' as const, value: result.container }
        : { status: result.status },
    );
  },
});

/**
 * The monitor's services. `selection` defaults to `fixtureSelection()` and
 * `records` to connected records; `null` leaves that provider out.
 */
export const monitorServices = (
  input: {
    readonly selection?: FixtureSelection | null;
    readonly records?: RuntimeRecords | null;
    readonly host?: () => HostResources;
    readonly project?: () => ProjectResourcesResult;
  } = {},
): Services =>
  fakeServices({
    ...(input.selection === null
      ? {}
      : { 'workspace.selection/v1': input.selection ?? fixtureSelection() }),
    ...(input.records === null
      ? {}
      : { 'runtime.records/v1': input.records ?? createRecordsApi() }),
    'resources/v1': fixtureResources({
      host: input.host ?? hostReading,
      project: input.project ?? (() => readyProject(containerReading())),
    }),
  });
