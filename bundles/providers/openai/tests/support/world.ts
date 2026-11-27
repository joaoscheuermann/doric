import { readFileSync } from 'node:fs';

import type { ModelKindDescriptor } from 'bundle/contracts';

/**
 * The kind this bundle provided before the closed llms catalog was removed,
 * frozen from the llms kind catalog.
 */
export const frozenKind = (): ModelKindDescriptor =>
  JSON.parse(
    readFileSync(
      new URL('../../../tests/fixtures/provider-kind.json', import.meta.url),
      'utf8',
    ),
  ) as ModelKindDescriptor;
