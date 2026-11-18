// H1: the shipped composition orders its bundles as they build on each other:
// `openui` comes before `papercraft`, which builds on it.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const hostDir = 'app/backend/doric-host';

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

interface ShippedComposition {
  readonly core: string;
  readonly enabled: readonly string[];
  readonly alternatives?: Readonly<
    Record<string, { readonly options: readonly string[] }>
  >;
}

/** Every bundle id the shipped composition names, enabled or alternative. */
const compositionIds = async (): Promise<string[]> => {
  const composition = (await readJson(
    join(hostDir, 'composition.json'),
  )) as unknown as ShippedComposition;

  return [
    ...new Set([
      composition.core,
      ...composition.enabled,
      ...Object.values(composition.alternatives ?? {}).flatMap(
        ({ options }) => options,
      ),
    ]),
  ];
};

void test('H1: the shipped composition enables openui before papercraft', async () => {
  const ids = await compositionIds();

  assert.ok(ids.includes('openui'), ids.join(', '));
  assert.ok(ids.indexOf('openui') < ids.indexOf('papercraft'), ids.join(', '));
});
