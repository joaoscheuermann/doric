// A component's compiled files, as the tests read them: `compileComponent`
// over a Project read through `files/v1` with `projectReaders`
// (`src/host/files.ts`): the source reader, the bytes reader and the
// repository-root probe the programs service passes it, on the host (no
// sandbox bundler: these tests give no lease). Each built file is answered as
// its path, its content hash and its base64 bytes. The reads go through a
// `files/v1` stub of `services`, adapted to `PapercraftFiles` here since the
// kernel's ports left with the kernel entry (S68c).

import { createHash } from 'node:crypto';

import type { Call, Services } from 'bundle/contracts';

import { FilesV1 } from '../../src/contracts/index.js';
import { compileComponent } from '../../src/host/compile.js';
import { projectReaders } from '../../src/host/files.js';
import type { PapercraftFiles } from '../../src/host/ports.js';

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

/** `files/v1` of `services` under the call's scope, as `PapercraftFiles`: bytes are read as base64 `content`. */
export const filesOver = (services: Services, call: Call): PapercraftFiles => {
  const files = () => services.use(FilesV1, call.scope);

  return {
    content: (path) => files().content({ path }, call),
    readBytes: async (path) => {
      const outcome = await files().content({ path, encoding: 'base64' }, call);
      if (outcome.status !== 'ready') return outcome;

      const read = outcome.value;

      return read.status === 'read'
        ? {
            status: 'ready',
            value: {
              status: 'read',
              bytes: Buffer.from(read.content, 'base64'),
              truncated: read.truncated,
            },
          }
        : { status: 'ready', value: read };
    },
  };
};

/** Compiles `input.path` (its `entry` export) into `index.js`, `index.css` and the sheet's assets. */
export const snapshotComponent = async (
  services: Services,
  call: Call,
  input: { readonly path: string; readonly entry?: string },
): Promise<ComponentSnapshot> => {
  const readers = projectReaders(filesOver(services, call), {
    projectId: call.scope?.projectId ?? '',
    call,
  });
  const compiled = await compileComponent(
    (path) => readers.source(path, path === input.path),
    {
      path: input.path,
      ...(input.entry === undefined ? {} : { entry: input.entry }),
    },
    undefined,
    readers.bytes,
    readers.isRepositoryRoot,
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
