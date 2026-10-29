// The `drawio` bundle's host part: provides `drawio.diagrams/v1`, registers
// the `diagram` kind in the artifacts registry and registers the
// `drawio_diagram` tool at its global model-visible position.

import { type Cleanup, type HostContext, ToolsV1 } from 'bundle/contracts';

import { ArtifactKindV1, DRAWIO_DIAGRAM_ORDER } from '../contracts/index.js';
import { drawioDiagramsService } from './diagrams.js';
import { diagramKind } from './kind.js';
import { tool } from './tools/drawio-diagram.js';

export const activate = async ({ services }: HostContext): Promise<Cleanup> => {
  services.provide(drawioDiagramsService);

  const kind = await services.use(ArtifactKindV1).register(diagramKind);

  services
    .use(ToolsV1)
    .register(tool, { alwaysAvailable: true, order: DRAWIO_DIAGRAM_ORDER });

  return () => {
    kind.dispose();
  };
};
