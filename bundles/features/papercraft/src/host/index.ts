// The `papercraft` bundle's host part: it serves papercraft fences
// (papercraft-openui.md D10, D14, D28, D25): `papercraft.programs/v1` over the
// host memo and the Project's sandbox, the `papercraft.cwd/v1` event and the
// two runtime hooks that append it and give the library instruct, and the
// `papercraft` skill, registered at activation.
//
// It reads Project sources through `files/v1` and comments through
// `comments/v1`, consumed through structural copies of their contracts so
// this bundle never imports theirs at compile time.

import { readFileSync } from 'node:fs';

import {
  type Cleanup,
  type Disposable,
  EventsV1,
  HooksV1,
  type HostContext,
  SkillsV1,
} from 'bundle/contracts';
import { RuntimeHooksV1 } from 'runtime/contracts';

import { cwdEvent } from '../contracts/index.js';
import { createLibraryHooks } from './library.js';
import { createPrograms } from './programs.js';
import { sandboxJobRunner } from './sandbox.js';

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

export const activate = ({ services }: HostContext): Cleanup => {
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

  // The skill is registered at activation (D25, D28); a registration that
  // fails (`unavailable_tool`) leaves it out (PC33).
  let registered: Disposable | undefined;
  try {
    registered = services.use(SkillsV1).register(skill, skillOptions);
  } catch {
    registered = undefined;
  }

  return () => {
    registered?.dispose();
    registered = undefined;
    hooks.dispose();
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
export { probeBytes, probeRepositoryRoot, probeSource } from './files.js';
export { findHarness, HARNESS_DIRS, harnessCandidates } from './harness.js';
export {
  bundleInSandbox,
  type RunnerSandbox,
  type RunnerScript,
  type SandboxBundle,
  type SandboxBundler,
  sandboxBundler,
} from './sandbox.js';
