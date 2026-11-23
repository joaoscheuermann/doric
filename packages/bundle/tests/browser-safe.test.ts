import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const compiled = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The package's self-reference to its generated code, resolved to the compiled tree. */
const selfGen = 'bundle/contracts/gen/';

/**
 * The bare modules an entry may reach at runtime: zod, Connect (with the
 * protocol modules `bundle/client`'s fetch transport is built on) and the
 * protobuf runtime its generated code uses. Anything else, a `node:` builtin
 * included, keeps the entry out of the window.
 */
const browserSafe = new Set([
  'zod',
  '@connectrpc/connect',
  '@connectrpc/connect/protocol',
  '@connectrpc/connect/protocol-connect',
  '@bufbuild/protobuf',
  '@bufbuild/protobuf/codegenv2',
  '@bufbuild/protobuf/wkt',
]);

const specifiers = (source: string): string[] =>
  [
    ...source.matchAll(
      /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    ),
    ...source.matchAll(/(?:^|\s)import\s*['"]([^'"]+)['"]/g),
    ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((match) => match[1] as string);

/** Every bare specifier reachable from an entry, following relative imports. */
const bareImports = async (entry: string): Promise<Set<string>> => {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);

    for (const specifier of specifiers(await readFile(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(join(dirname(file), specifier));
      } else if (specifier.startsWith(selfGen)) {
        queue.push(
          join(compiled, 'contracts', 'gen', specifier.slice(selfGen.length)),
        );
      } else {
        bare.add(specifier);
      }
    }
  }

  return bare;
};

for (const entry of ['contracts', 'runtime', 'sdk/client']) {
  void test(`bundle/${entry} reaches only its own modules, zod, Connect and protobuf`, async () => {
    const bare = await bareImports(join(compiled, entry, 'index.js'));

    assert.deepEqual(
      [...bare].filter((specifier) => !browserSafe.has(specifier)).sort(),
      [],
    );
  });
}
