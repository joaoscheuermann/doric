import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const compiled = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

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
      } else {
        bare.add(specifier);
      }
    }
  }

  return bare;
};

for (const entry of ['contracts', 'runtime']) {
  void test(`bundle/${entry} reaches only relative modules and zod`, async () => {
    const bare = await bareImports(join(compiled, entry, 'index.js'));

    assert.deepEqual([...bare], ['zod']);
  });
}
