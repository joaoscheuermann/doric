// The window services `<resources-monitor>` reads: `layout.workspace/v1`
// for the selected Project and `resources/v1` for the readings, both over
// fixtures.

import type { Services } from 'bundle/contracts';

import type { LayoutWorkspace } from '../../src/client/api/peers.js';
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

/** A workspace that shows one Project and never changes its selection. */
export const fixtureWorkspace = (
  selectedProjectId: string | undefined = projectId,
): LayoutWorkspace => ({
  selection: () =>
    selectedProjectId === undefined
      ? {}
      : { project: { id: selectedProjectId } },
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

export const monitorServices = (
  input: {
    readonly workspace?: LayoutWorkspace | null;
    readonly host?: () => HostResources;
    readonly project?: () => ProjectResourcesResult;
  } = {},
): Services =>
  fakeServices({
    ...(input.workspace === null
      ? {}
      : { 'layout.workspace/v1': input.workspace ?? fixtureWorkspace() }),
    'resources/v1': fixtureResources({
      host: input.host ?? hostReading,
      project: input.project ?? (() => readyProject(containerReading())),
    }),
  });
