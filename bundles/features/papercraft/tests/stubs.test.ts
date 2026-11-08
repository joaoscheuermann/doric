// PC7 (D12): the signatures are evaluated under Node in the library job, with
// every import from outside `schemas/` replaced by a stub. Over the built
// runner in a real workspace folder.
//
// Contract matrix:
// - `forwardRef`, `cva` and `styled.div` imported from `src/` evaluate at
//   module scope, and each signature equals lang-core's
//   `library.toSpec().components[name].signature` for the same schema;
// - `z.enum(variants)` with `variants` from `src/` fails naming the entry
//   file and the import;
// - `z.string().max(LIMIT)` with a stubbed `LIMIT` fails through the schema
//   walk, naming the entry file and the import;
// - a schema that loops forever fails after 10 s.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { createLibrary, defineComponent } from '@openuidev/lang-core';
import { z } from 'zod';

import type { LibraryOutput } from '../src/sandbox/protocol.js';
import {
  diskWorkspace,
  libraryJob,
  removeWorkspaces,
} from './support/disk-sandbox.js';

after(removeWorkspaces);

const SCHEMAS = '.doric/papercraft/schemas';

/** `src/ui.ts`: real values, which the evaluation never runs. */
const UI = [
  'export const forwardRef = (render: unknown) => render;',
  'export const cva = (base: string, _config?: unknown) => () => base;',
  'export const styled = { div: (..._parts: unknown[]) => () => null };',
  "export const variants = ['solid', 'ghost'] as const;",
  'export const LIMIT = 40;',
  '',
].join('\n');

const header = [
  "import { defineComponent } from '@openuidev/react-lang';",
  "import { z } from 'zod';",
].join('\n');

const job = async (name: string, body: string): Promise<LibraryOutput> => {
  const workspace = await diskWorkspace({
    'src/ui.ts': UI,
    [`${SCHEMAS}/${name}.tsx`]: `${header}\n${body}\n`,
  });

  return await libraryJob(workspace, { cwd: workspace.root });
};

const failure = (output: LibraryOutput): string => {
  assert.equal(output.status, 'failed', JSON.stringify(output).slice(0, 400));
  return (output as { error: string }).error;
};

describe('PC7: evaluation with stubs', () => {
  test('module-scope forwardRef, cva and styled.div evaluate; signatures equal toSpec()', async () => {
    const output = await job(
      'AppCard',
      [
        "import { cva, forwardRef, styled } from '../../../src/ui';",
        'const Inner = forwardRef(() => null);',
        "const tone = cva('card', { variants: { size: { sm: 'sm' } } });",
        'const Box = styled.div`padding: 4px;`;',
        'void tone; void Box;',
        'export const AppCard = defineComponent({',
        "  name: 'AppCard',",
        "  description: 'A card with a title.',",
        '  props: z.object({',
        '    title: z.string().max(80),',
        "    tone: z.enum(['info', 'warning']).optional(),",
        '    count: z.number().int(),',
        '  }),',
        '  component: Inner,',
        '});',
      ].join('\n'),
    );

    const expected = createLibrary({
      components: [
        defineComponent({
          name: 'AppCard',
          description: 'A card with a title.',
          props: z.object({
            title: z.string().max(80),
            tone: z.enum(['info', 'warning']).optional(),
            count: z.number().int(),
          }),
          component: null,
        }),
      ],
    }).toSpec().components.AppCard;

    assert.equal(output.status, 'built', JSON.stringify(output).slice(0, 400));
    const built = output as Extract<LibraryOutput, { status: 'built' }>;
    assert.deepEqual(built.components, [
      {
        name: 'AppCard',
        description: expected?.description,
        signature: expected?.signature,
        file: `${SCHEMAS}/AppCard.tsx`,
      },
    ]);
  });

  test('z.enum(variants) with variants from src/ fails naming the entry file and the import', async () => {
    const error = failure(
      await job(
        'AppToggle',
        [
          "import { variants } from '../../../src/ui';",
          'export const AppToggle = defineComponent({',
          "  name: 'AppToggle',",
          "  description: 'A toggle.',",
          '  props: z.object({ variant: z.enum(variants) }),',
          '  component: () => null,',
          '});',
        ].join('\n'),
      ),
    );

    assert.ok(error.includes('AppToggle.tsx'), error);
    assert.ok(error.includes('`variants`'), error);
    assert.ok(error.includes('../../../src/ui'), error);
    assert.ok(
      error.includes(
        'which is outside schemas/. Schema values must come from schemas/ or from zod.',
      ),
      error,
    );
  });

  test('z.string().max(LIMIT) with a stubbed LIMIT fails through the schema walk', async () => {
    const error = failure(
      await job(
        'AppField',
        [
          "import { LIMIT } from '../../../src/ui';",
          'export const AppField = defineComponent({',
          "  name: 'AppField',",
          "  description: 'A field.',",
          '  props: z.object({ value: z.string().max(LIMIT) }),',
          '  component: () => null,',
          '});',
        ].join('\n'),
      ),
    );

    assert.ok(error.includes('AppField.tsx'), error);
    assert.ok(error.includes('`LIMIT`'), error);
    assert.ok(error.includes('outside schemas/'), error);
  });

  test('a schema that loops forever fails after 10 s', {
    timeout: 90_000,
  }, async () => {
    const startedAt = Date.now();
    const error = failure(
      await job(
        'AppLoop',
        [
          'for (;;) { /* never ends */ }',
          'export const AppLoop = defineComponent({',
          "  name: 'AppLoop',",
          "  description: 'Never.',",
          '  props: z.object({}),',
          '  component: () => null,',
          '});',
        ].join('\n'),
      ),
    );

    assert.equal(error, 'Evaluating the schemas did not finish in 10 s');
    assert.ok(Date.now() - startedAt >= 10_000);
  });
});
