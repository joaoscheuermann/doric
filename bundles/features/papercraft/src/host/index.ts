// The `papercraft` bundle's host part: provides `papercraft.previews/v1`,
// registers the `preview` kind in the artifacts registry and registers the
// `papercraft_preview` tool at its global model-visible position.
//
// It also serves papercraft fences (papercraft-openui.md D10, D14, D28):
// `papercraft.programs/v1` over the host memo and the Project's sandbox, the
// `papercraft.cwd/v1` event and the two runtime hooks that append it and give
// the library instruct, and the `papercraft` skill while the Generative UI
// setting is on.
//
// It reads Project sources through `files/v1`, creates and revises artifacts
// through `artifacts/v1` and reads their comments through `comments/v1` — all
// three in the manifest's `requires`, consumed through structural copies of
// their contracts so this bundle never imports theirs at compile time.

import { readFileSync } from 'node:fs';

import {
  type Cleanup,
  type Disposable,
  EventsV1,
  HooksV1,
  type HostContext,
  SettingsV1,
  SkillsV1,
  ToolsV1,
} from 'bundle/contracts';
import { generativeUiSetting } from 'openui/contracts';
import { RuntimeHooksV1 } from 'runtime/contracts';

import { ArtifactKindV1, cwdEvent } from '../contracts/index.js';
import { previewKind } from './kind.js';
import { createLibraryHooks } from './library.js';
import { papercraftPreviewsService } from './previews.js';
import { createPrograms } from './programs.js';
import { sandboxJobRunner } from './sandbox.js';
import { PAPERCRAFT_PREVIEW_ORDER, tool } from './tools/papercraft-preview.js';

/** D28's `papercraft` skill; its body is the committed text. */
const skill = {
  name: 'papercraft',
  description:
    'Previews repository components and exports live in the conversation: OpenUI Lang programs in papercraft fences, with the repository library, Export and pinned comments. Load it before writing a papercraft fence.',
  allowedTools: ['comment_reply'],
  body: readFileSync(
    new URL('./skills/papercraft.md', import.meta.url),
    'utf8',
  ).trim(),
};

/** D28's options: after `openui`'s 3400, listed and loaded on demand. */
const skillOptions = { order: 3410, alwaysAvailable: false } as const;

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

  // Papercraft fences (D10, D14): the programs service over the sandbox, its
  // binding read from the Thread's `papercraft.cwd/v1` events.
  const programs = createPrograms(services, {
    runJob: sandboxJobRunner(services),
    cwdAt: (scope, turnSequence) => library.cwdAt(scope, turnSequence),
  });
  const library = createLibraryHooks(services, programs);
  services.use(EventsV1).register(cwdEvent);

  const hooks = services
    .use(HooksV1)
    .whenAvailable(RuntimeHooksV1, (registrar) => {
      const started = registrar.onPromptStartedHook((input) =>
        library.promptStarted(input),
      );
      const moved = registrar.onThreadCwdChangedHook((input) =>
        library.cwdChanged(input),
      );

      return () => {
        started.dispose();
        moved.dispose();
      };
    });

  // The skill exists only while the setting is on (D28); a registration that
  // fails (`unavailable_tool`) leaves it out until the setting next turns on.
  const settings = services.use(SettingsV1);
  let registered: Disposable | undefined;
  let stopped = false;
  const follow = (enabled: boolean): void => {
    if (stopped) return;
    if (enabled && registered === undefined) {
      try {
        registered = services.use(SkillsV1).register(skill, skillOptions);
      } catch {
        registered = undefined;
      }
    } else if (!enabled && registered !== undefined) {
      registered.dispose();
      registered = undefined;
    }
  };

  let written = false;
  const subscription = settings.subscribe(generativeUiSetting, (entry) => {
    written = true;
    follow(entry.value.enabled);
  });
  void Promise.resolve()
    .then(() => settings.get(generativeUiSetting))
    .then(
      (value) => {
        if (!written) follow(value.enabled);
      },
      () => undefined,
    );

  return () => {
    stopped = true;
    subscription.dispose();
    registered?.dispose();
    registered = undefined;
    hooks.dispose();
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
export { type CompiledStyles, compileStyles } from './css.js';
export { isStoriesFile, storyOrder } from './entry.js';
export { findHarness, HARNESS_DIRS, harnessCandidates } from './harness.js';
export type { PreviewKindMaterialize, PreviewMaterialization } from './kind.js';
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
