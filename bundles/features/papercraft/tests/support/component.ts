// A component's compiled files, as the tests read them: `compileComponent`
// over a Project read through `files/v1` (`src/host/files.ts`), with the
// sandbox bundler, the bytes reader and the repository-root probe the
// programs service passes it. Each built file is answered as its path, its
// content hash and its base64 bytes.

import { createHash } from 'node:crypto';

import type { Call, Services } from 'bundle/contracts';

import { compileComponent } from '../../src/host/compile.js';
import {
  probeBytes,
  probeRepositoryRoot,
  probeSource,
} from '../../src/host/files.js';
import { sandboxBundler } from '../../src/host/sandbox.js';

/** One compile's files: the module, its sheet and the sheet's assets. */
export interface ComponentSnapshot {
  readonly entries: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly files: readonly { readonly path: string; readonly base64: string }[];
  /** What the build skipped without failing (a component's CSS imports). */
  readonly warnings: readonly string[];
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Compiles `input.path` (its `entry` export) into `index.js`, `index.css` and the sheet's assets. */
export const snapshotComponent = async (
  services: Services,
  call: Call,
  input: { readonly path: string; readonly entry?: string },
): Promise<ComponentSnapshot> => {
  const compiled = await compileComponent(
    (path) => probeSource(services, call, path, path === input.path),
    {
      path: input.path,
      ...(input.entry === undefined ? {} : { entry: input.entry }),
    },
    sandboxBundler(services, call),
    (path) => probeBytes(services, call, path),
    (dir) => probeRepositoryRoot(services, call, dir),
  );
  const built = [
    { path: 'index.js', bytes: utf8(compiled.js) },
    { path: 'index.css', bytes: utf8(compiled.css) },
    ...compiled.assets,
  ];

  return {
    entries: built.map(({ path, bytes }) => ({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
    files: built.map(({ path, bytes }) => ({
      path,
      base64: Buffer.from(bytes).toString('base64'),
    })),
    warnings: compiled.warnings,
  };
};
