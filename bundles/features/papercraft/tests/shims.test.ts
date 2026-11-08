// PC8, PC28 (D13): a compiled library never carries its own copy of
// react-lang, lang-core or zod: its imports resolve to shims over the
// namespaces the frame entry publishes, and the name lists the shims export
// are generated from the installed packages.
//
// Contract matrix:
// - PC8: in a library job, `zod` and `zod/v4` read the `zod` namespace,
//   `zod/v4/core` reads `zodCore`, `@openuidev/react-lang` reads `reactLang`;
//   every shim reads `globalThis[Symbol.for('doric.papercraft.openui')]` and
//   the module names no URL; `zod/mini` fails with D13's error, in the job and
//   in `bundleModule`;
// - PC28: `src/sandbox/shim-names.ts` equals what `scripts/shim-names.mjs`
//   writes from the installed packages.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ContractError } from 'bundle/contracts';

import { bundleModule, ZOD_ENTRY_ERROR } from '../src/host/bundle.js';
import type { LibraryOutput } from '../src/sandbox/protocol.js';
import {
  diskWorkspace,
  libraryJob,
  removeWorkspaces,
} from './support/disk-sandbox.js';

after(removeWorkspaces);

const run = promisify(execFile);
const SCHEMAS = '.doric/papercraft/schemas';
/** D13's error, as the design words it. */
const D13_ERROR =
  "This zod entry is not served in papercraft libraries; import from 'zod'.";

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('PC8: the shims', () => {
  test('zod, zod/v4, zod/v4/core and react-lang read the frame namespaces; no URL', async () => {
    const workspace = await diskWorkspace({
      [`${SCHEMAS}/AppZod.tsx`]: [
        "import { defineComponent } from '@openuidev/react-lang';",
        "import { z } from 'zod/v4';",
        "import * as plain from 'zod';",
        "import * as core from 'zod/v4/core';",
        'export const coreSeen = typeof core.$ZodType;',
        'export const plainSeen = typeof plain.z;',
        'export const AppZod = defineComponent({',
        "  name: 'AppZod',",
        "  description: 'Uses every zod entry served.',",
        '  props: z.object({ label: z.string() }),',
        '  component: () => null,',
        '});',
        '',
      ].join('\n'),
    });

    const output = await libraryJob(workspace, { cwd: workspace.root });

    assert.equal(output.status, 'built', JSON.stringify(output).slice(0, 400));
    const { js } = output as Extract<LibraryOutput, { status: 'built' }>;
    assert.match(js, /Symbol\.for\(\s*["']doric\.papercraft\.openui["']\s*\)/u);
    assert.match(js, /\.zod\b(?!Core)/u);
    assert.match(js, /\.zodCore\b/u);
    assert.match(js, /\.reactLang\b/u);
    assert.doesNotMatch(js, /doric:\/\//u);
    assert.doesNotMatch(js, /https?:\/\//u);
    // No copy of zod's own code is bundled.
    assert.doesNotMatch(js, /\$ZodType\s*=\s*\/\*/u);
  });

  test('zod/mini fails the library with D13 error', async () => {
    const workspace = await diskWorkspace({
      [`${SCHEMAS}/AppMini.tsx`]: [
        "import { defineComponent } from '@openuidev/react-lang';",
        "import { z } from 'zod/mini';",
        'export const AppMini = defineComponent({',
        "  name: 'AppMini',",
        "  description: 'Mini.',",
        '  props: z.object({}),',
        '  component: () => null,',
        '});',
        '',
      ].join('\n'),
    });

    const output = await libraryJob(workspace, { cwd: workspace.root });

    assert.equal(output.status, 'failed', JSON.stringify(output).slice(0, 400));
    assert.ok((output as { error: string }).error.includes(D13_ERROR));
  });

  test('bundleModule refuses a zod entry the shims do not serve, and serves the ones they do', async () => {
    const { build } = await import('esbuild');
    const input = {
      read: async () => undefined,
      build,
      base: `${SCHEMAS}/entry.ts`,
      windowServes: async () => true,
      shims: {
        zod: 'export const z = globalThis.marker_zod_shim;',
      },
    };

    assert.equal(ZOD_ENTRY_ERROR, D13_ERROR);
    await assert.rejects(
      bundleModule({
        ...input,
        code: "import { z } from 'zod/mini';\nexport default z;\n",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.code, 'invalid_input');
        assert.ok(error.message.includes(D13_ERROR), error.message);
        return true;
      },
    );

    const served = await bundleModule({
      ...input,
      code: "import { z } from 'zod';\nexport default z;\n",
    });
    assert.match(served.js, /marker_zod_shim/u);
  });
});

describe('PC28: the shim name lists', () => {
  test('src/sandbox/shim-names.ts equals what scripts/shim-names.mjs writes', async () => {
    const target = `${PACKAGE_ROOT}src/sandbox/shim-names.ts`;
    const committed = await readFile(target, 'utf8');

    try {
      await run(process.execPath, [`${PACKAGE_ROOT}scripts/shim-names.mjs`], {
        cwd: PACKAGE_ROOT,
      });
      const written = await readFile(target, 'utf8');

      assert.equal(
        written,
        committed,
        'the committed name lists differ from the installed packages: run scripts/shim-names.mjs',
      );
      assert.match(committed, /BUILTIN_COMPONENT_NAMES/u);
      assert.match(committed, /SHIM_ABI/u);
    } finally {
      await writeFile(target, committed);
    }
  });
});
