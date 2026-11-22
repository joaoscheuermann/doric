// Generated imports, the spike of A53 (spec `docs/designs/grpc-processes.md`,
// section 8, "Generated code across packages"; T1.3, AC1.4): git imports the
// generated code of `files/v1` through files' export `./contracts/gen/*`, in
// Node and in an esbuild bundle. The generated file in turn imports `bundle`'s
// generated `options_pb` and `buf/validate`, so the bundle resolves imports
// across three packages.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { build } from 'esbuild';
import { FilesService } from 'files/contracts/gen/doric/files/v1/files_pb.js';

const specifier = 'files/contracts/gen/doric/files/v1/files_pb.js';

describe('files/contracts/gen from git', () => {
  test('Node imports FilesService with its seven RPCs', () => {
    assert.equal(FilesService.typeName, 'doric.files.v1.FilesService');
    assert.deepEqual(Object.keys(FilesService.method).sort(), [
      'content',
      'createDirectory',
      'createFile',
      'directories',
      'directory',
      'readBytes',
      'tree',
    ]);
  });

  test('an esbuild bundle of a module that imports it builds', async () => {
    // Inside the project, so the module resolves `files` as git's own code does.
    const dir = await mkdtemp(
      join('bundles/features/git/dist-tests', 'gen-import-'),
    );
    try {
      const entry = join(dir, 'entry.mjs');
      await writeFile(
        entry,
        `import { FilesService } from '${specifier}';\nexport const name = FilesService.typeName;\n`,
      );
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
      });
      assert.deepEqual(result.errors, []);
      const output = result.outputFiles.map((file) => file.text).join('\n');
      assert.match(output, /file_doric_files_v1_files/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
