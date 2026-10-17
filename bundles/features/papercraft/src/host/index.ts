// The `papercraft` bundle's host part: provides `papercraft.previews/v1`,
// registers the `preview` kind in the artifacts registry and registers the
// `papercraft_preview` tool at its global model-visible position.
//
// It reads Project sources through `files/v1`, creates and revises artifacts
// through `artifacts/v1` and reads their comments through `comments/v1` — all
// three in the manifest's `requires`, consumed through structural copies of
// their contracts so this bundle never imports theirs at compile time.

import { type Cleanup, type HostContext, ToolsV1 } from 'bundle/contracts';

import { ArtifactKindV1 } from '../contracts/index.js';
import { previewKind } from './kind.js';
import { papercraftPreviewsService } from './previews.js';
import { PAPERCRAFT_PREVIEW_ORDER, tool } from './tools/papercraft-preview.js';

export const activate = async ({ services }: HostContext): Promise<Cleanup> => {
  services.provide(papercraftPreviewsService);

  // The `preview` kind, before any artifact exists: the registry is usable
  // independently of an instance. The declaration carries the kind's own
  // payload schema, its own materialization (the bundle's build over
  // `files/v1`: path A markup, or a path B module) and the body the registry's frame mounts (`bodyTag`).
  const kind = await services
    .use(ArtifactKindV1)
    .register(previewKind(services));

  // The global model-visible position, the next free band after `threads`
  // (1000–1600).
  services
    .use(ToolsV1)
    .register(tool, { alwaysAvailable: true, order: PAPERCRAFT_PREVIEW_ORDER });

  return () => {
    kind.dispose();
  };
};

export {
  type BundledComponent,
  bundleComponent,
  HOST_PACKAGES,
  pickExport,
  pickStory,
  previewExternals,
  type SourceReader,
  WINDOW_PACKAGES,
} from './bundle.js';
export { type CompiledComponent, compileComponent } from './compile.js';
export {
  type CompiledStyles,
  compileStyles,
  scopeRootSelectors,
} from './css.js';
export { isStoriesFile, storyOrder } from './entry.js';
export { findHarness, HARNESS_DIRS, harnessCandidates } from './harness.js';
export type {
  PreviewKindMaterialize,
  PreviewMaterialization,
} from './kind.js';
export { previewKind, previewKindPayloadSchema } from './kind.js';
export {
  buildPreview,
  builtFiles,
  deriveMarkup,
  MARKUP_ENTRY,
  MAX_SOURCE_BYTES,
  MODULE_ENTRY,
  type PreviewSnapshot,
  type PreviewSnapshotInput,
  papercraftPreviewsService,
  probeSource,
  readPreview,
  readSource,
  STYLES_ENTRY,
  sha256,
  snapshotPreview,
  stampRoot,
  stampSource,
} from './previews.js';
export {
  bundleInSandbox,
  type RunnerSandbox,
  type RunnerScript,
  type SandboxBundle,
  type SandboxBundler,
  sandboxBundler,
} from './sandbox.js';
export type {
  PendingComment,
  PreviewToolInput,
  PreviewToolOutput,
} from './tools/papercraft-preview.js';
export {
  defaultTargets,
  PAPERCRAFT_PREVIEW_ORDER,
  PAPERCRAFT_PREVIEW_TOOL,
  tool as papercraftPreviewTool,
} from './tools/papercraft-preview.js';
