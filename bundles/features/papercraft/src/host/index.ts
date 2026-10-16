// The `papercraft` bundle's host part: provides `papercraft.previews/v1`,
// registers the `preview` kind in the artifacts registry and registers the
// `papercraft_preview` tool at its global model-visible position.
//
// It reads Project sources through `files/v1` and creates artifacts through
// `artifacts/v1`; it declares neither, so the composition decides which
// implementations of those bundles it meets.

import { type HostContext, ToolsV1 } from 'bundle/contracts';

import { ArtifactKindV1 } from '../contracts/index.js';
import { previewKind } from './kind.js';
import { papercraftPreviewsService } from './previews.js';
import { PAPERCRAFT_PREVIEW_ORDER, tool } from './tools/papercraft-preview.js';

export const activate = ({ services }: HostContext): void => {
  services.provide(papercraftPreviewsService);

  // The `preview` kind, before any artifact exists: the registry is usable
  // independently of an instance. The declaration carries the kind's own
  // payload schema, its own materialization (the bundle's path A over
  // `files/v1`) and the `blockType` its renderer draws: a kind that declares
  // one owns its node surface, so the `artifacts` bundle's client leaves the
  // `artifacts.*` pair to this bundle's client.
  services.use(ArtifactKindV1).register(previewKind(services));

  // The global model-visible position, the next free band after `threads`
  // (1000–1600).
  services
    .use(ToolsV1)
    .register(tool, { alwaysAvailable: true, order: PAPERCRAFT_PREVIEW_ORDER });
};

export type {
  PreviewKindMaterialize,
  PreviewMaterialization,
} from './kind.js';
export { previewKind, previewKindPayloadSchema } from './kind.js';
export {
  buildPreview,
  builtFiles,
  deriveMarkup,
  MAX_SOURCE_BYTES,
  papercraftPreviewsService,
  readPreview,
  readSource,
  sha256,
  stampRoot,
  stampSource,
} from './previews.js';
export {
  defaultTargets,
  PAPERCRAFT_PREVIEW_ORDER,
  PAPERCRAFT_PREVIEW_TOOL,
  tool as papercraftPreviewTool,
} from './tools/papercraft-preview.js';
