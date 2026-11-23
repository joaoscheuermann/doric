import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

/** The repository root, from `packages/bundle/dist-tests/tests`. */
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const googleapis = 'buf.build/googleapis/googleapis';

interface RunCommandsOptions {
  readonly command?: string;
  readonly commands?: ReadonlyArray<string | { readonly command: string }>;
}

/** The commands of the root `proto-export` target, in order. */
const protoExportCommands = async (): Promise<string[]> => {
  const project = JSON.parse(
    await readFile(resolve(root, 'project.json'), 'utf8'),
  ) as { targets: Record<string, { options?: RunCommandsOptions }> };
  const options = project.targets['proto-export']?.options ?? {};

  return [
    ...(options.command === undefined ? [] : [options.command]),
    ...(options.commands ?? []).map((entry) =>
      typeof entry === 'string' ? entry : entry.command,
    ),
  ];
};

/** The commit `buf.lock` pins for googleapis. */
const lockedCommit = async (): Promise<string | undefined> => {
  const lock = parse(await readFile(resolve(root, 'buf.lock'), 'utf8')) as {
    deps?: ReadonlyArray<{ name: string; commit: string }>;
  };

  return lock.deps?.find((dep) => dep.name === googleapis)?.commit;
};

void test('proto-export exports error_details.proto from the googleapis commit buf.lock pins', async () => {
  const locked = await lockedCommit();

  assert.ok(locked, `buf.lock pins ${googleapis}`);

  const exports = (await protoExportCommands()).filter((command) =>
    command.includes('google/rpc/error_details.proto'),
  );

  assert.equal(
    exports.length,
    1,
    'proto-export has one command exporting google/rpc/error_details.proto',
  );

  const pinned = (exports[0] as string).match(
    /buf\.build\/googleapis\/googleapis:([0-9a-f]+)/,
  )?.[1];

  assert.equal(pinned, locked);
});
