// PC5, PC6, PC25 (D10, D11, D14, D15, D8): the library job as the built runner
// runs it in a sandbox over a real workspace folder (`tests/support/disk-sandbox.ts`):
// the input is `LibraryRunnerInput`, the answer `libraryOutputSchema`.
//
// Contract matrix:
// - PC5: the walk from `cwd` stops at the nearest repository root (a `.git`
//   directory or file), so an outer library is not found; a library inside
//   the nested repository is; a missing `cwd` fails; the harness search
//   stops at the nested repository for a library and for an `Export` build
//   (the runner's disk probe; `findHarness`'s probe parameter);
// - PC6: two components in a file, a name other than the file's, the
//   reserved names (react-ui's `Card`, `Export`, the built-in calls, `Action`,
//   `Query`, `AskForm`), 101 entry files and a 17 KiB file fail naming the
//   file or the limit; `Filters` compiles;
// - PC25: a `.gitignore` rule hiding the first entry file gives `ignoredBy`
//   as `<source>:<line>`; a `git` that sleeps 6 s and no `git` give none, and
//   the job still answers.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { findHarness } from '../src/host/harness.js';
import type { LibraryOutput } from '../src/sandbox/protocol.js';
import {
  bundleJob,
  type DiskWorkspace,
  type DiskWorkspaceOptions,
  diskWorkspace,
  libraryJob,
  removeWorkspaces,
} from './support/disk-sandbox.js';

after(removeWorkspaces);

const run = promisify(execFile);

const SCHEMAS = '.doric/papercraft/schemas';

/** An entry file declaring one component `name`. */
const entry = (name: string, extra = ''): string =>
  [
    "import { defineComponent } from '@openuidev/react-lang';",
    "import { z } from 'zod';",
    extra,
    `export const ${name.replace(/\W/gu, '_')} = defineComponent({`,
    `  name: '${name}',`,
    `  description: 'The ${name}.',`,
    '  props: z.object({ label: z.string() }),',
    '  component: () => null,',
    '});',
    '',
  ].join('\n');

const library = (
  files: Readonly<Record<string, string>>,
  options?: DiskWorkspaceOptions,
): Promise<DiskWorkspace> => diskWorkspace(files, options);

const failed = (output: LibraryOutput) => {
  assert.equal(output.status, 'failed', JSON.stringify(output).slice(0, 400));
  return output as Extract<LibraryOutput, { status: 'failed' }>;
};

const built = (output: LibraryOutput) => {
  assert.equal(output.status, 'built', JSON.stringify(output).slice(0, 400));
  return output as Extract<LibraryOutput, { status: 'built' }>;
};

/** Makes `apps/web` a nested repository: a real `git init`, or a worktree's `.git` file. */
const nest = async (
  workspace: DiskWorkspace,
  kind: 'directory' | 'file',
): Promise<void> => {
  if (kind === 'directory') {
    await run('git', ['init', '-q'], { cwd: join(workspace.root, 'apps/web') });
  } else {
    await writeFile(
      join(workspace.root, 'apps/web/.git'),
      'gitdir: ../../.git/worktrees/web\n',
    );
  }
};

describe('PC5: discovery stops at the nearest repository root', () => {
  for (const kind of ['directory', 'file'] as const) {
    test(`a .git ${kind} in apps/web hides the workspace root's library`, async () => {
      const workspace = await library({
        [`${SCHEMAS}/RootPanel.tsx`]: entry('RootPanel'),
        'apps/web/src/main.ts': 'export {};\n',
      });
      await nest(workspace, kind);

      assert.deepEqual(
        await libraryJob(workspace, { cwd: `${workspace.root}/apps/web/src` }),
        { status: 'none' },
      );
    });
  }

  test('a library in the nested repository is its root', async () => {
    const workspace = await library({
      [`${SCHEMAS}/RootPanel.tsx`]: entry('RootPanel'),
      [`apps/web/${SCHEMAS}/WebCard.tsx`]: entry('WebCard'),
      'apps/web/src/main.ts': 'export {};\n',
    });
    await nest(workspace, 'directory');

    const output = built(
      await libraryJob(workspace, { cwd: `${workspace.root}/apps/web/src` }),
    );

    assert.equal(output.root, `${workspace.root}/apps/web`);
    assert.deepEqual(
      output.components.map(({ name }) => name),
      ['WebCard'],
    );
  });

  test('a missing cwd fails, naming it', async () => {
    const workspace = await library({
      [`${SCHEMAS}/RootPanel.tsx`]: entry('RootPanel'),
    });
    const cwd = `${workspace.root}/gone/away`;

    const output = failed(await libraryJob(workspace, { cwd }));

    assert.equal(output.error, `The working directory ${cwd} no longer exists`);
  });

  test("the harness search does not reach the outer repository's .storybook/, for a library and an Export", async () => {
    const outer = [
      "import type { ReactNode } from 'react';",
      'export const decorators = [(Story: () => ReactNode) => <div data-outer="outer-harness-marker"><Story /></div>];',
      '',
    ].join('\n');
    const files = {
      '.storybook/preview.tsx': outer,
      [`apps/web/${SCHEMAS}/WebCard.tsx`]: entry('WebCard'),
      'apps/web/src/Card.tsx':
        'export default function Card() { return <div>card</div>; }\n',
    };

    // Without the nested repository, today's walk finds the outer harness.
    const flat = await library(files);
    const flatExport = await bundleJob(flat, { path: 'apps/web/src/Card.tsx' });
    assert.equal(
      flatExport.status === 'built' ? flatExport.harness : undefined,
      '.storybook/preview.tsx',
    );

    const nested = await library(files);
    await nest(nested, 'directory');
    const exported = await bundleJob(nested, { path: 'apps/web/src/Card.tsx' });
    assert.equal(exported.status, 'built');
    assert.equal(
      exported.status === 'built' ? exported.harness : 'failed',
      undefined,
    );

    const output = built(
      await libraryJob(nested, { cwd: `${nested.root}/apps/web` }),
    );
    assert.equal(output.harness, undefined);
    assert.doesNotMatch(output.js, /outer-harness-marker/u);
  });

  test('findHarness stops after the directory the probe answers true for', async () => {
    const present = new Set(['.storybook/preview.tsx']);
    const read = async (path: string) =>
      present.has(path) ? 'export const decorators = [];' : undefined;

    assert.equal(
      await findHarness(read, 'apps/web/src/Card.tsx', async () => false),
      '.storybook/preview.tsx',
    );
    assert.equal(
      await findHarness(
        read,
        'apps/web/src/Card.tsx',
        async (dir) => dir === 'apps/web',
      ),
      undefined,
    );
    // A harness in the repository root itself is still found.
    present.add('apps/web/.storybook/preview.tsx');
    assert.equal(
      await findHarness(
        read,
        'apps/web/src/Card.tsx',
        async (dir) => dir === 'apps/web',
      ),
      'apps/web/.storybook/preview.tsx',
    );
    // A rejected probe counts as false.
    present.delete('apps/web/.storybook/preview.tsx');
    assert.equal(
      await findHarness(read, 'apps/web/src/Card.tsx', async () => {
        throw new Error('no lease');
      }),
      '.storybook/preview.tsx',
    );
  });
});

describe('PC6: the layout, the reserved names and the limits', () => {
  const failsNaming = async (
    files: Readonly<Record<string, string>>,
    expected: readonly (string | RegExp)[],
  ) => {
    const workspace = await library(files);
    const output = failed(await libraryJob(workspace, { cwd: workspace.root }));
    assert.equal(output.root, workspace.root);
    for (const part of expected) {
      if (typeof part === 'string') {
        assert.ok(output.error.includes(part), `${output.error} names ${part}`);
      } else {
        assert.match(output.error, part);
      }
    }
    assert.ok(output.error.length <= 4_096);
  };

  test('a file with two components fails naming the file', async () => {
    await failsNaming(
      {
        [`${SCHEMAS}/AppPair.tsx`]: `${entry('AppPair')}\nexport const Second = defineComponent({ name: 'AppPair2', description: 'x', props: z.object({}), component: () => null });\n`,
      },
      ['AppPair.tsx'],
    );
  });

  test('a component named other than its file fails naming the file', async () => {
    await failsNaming({ [`${SCHEMAS}/AppNamed.tsx`]: entry('AppOther') }, [
      'AppNamed.tsx',
    ]);
  });

  for (const name of [
    'Card',
    'Export',
    'Filter',
    'Sort',
    'Each',
    'Run',
    'ToAssistant',
    'Action',
    'Query',
    'AskForm',
  ]) {
    test(`the reserved name ${name} fails as a built-in of papercraft fences`, async () => {
      await failsNaming({ [`${SCHEMAS}/${name}.tsx`]: entry(name) }, [
        `${name}.tsx`,
        'a built-in of papercraft fences',
      ]);
    });
  }

  test('101 entry files fail naming the limit', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 101; index += 1) {
      const name = `AppItem${String(index).padStart(3, '0')}`;
      files[`${SCHEMAS}/${name}.tsx`] = entry(name);
    }
    await failsNaming(files, [/100/u]);
  });

  test('a 17 KiB entry file fails naming the file and the limit', async () => {
    await failsNaming(
      {
        [`${SCHEMAS}/AppHuge.tsx`]: `${entry('AppHuge')}\n// ${'x'.repeat(17 * 1024)}\n`,
      },
      ['AppHuge.tsx', /16 KiB|16,384|16384/u],
    );
  });

  test('a component named Filters compiles', async () => {
    const workspace = await library({
      [`${SCHEMAS}/Filters.tsx`]: entry('Filters'),
    });

    const output = built(await libraryJob(workspace, { cwd: workspace.root }));

    assert.deepEqual(
      output.components.map(({ name, file }) => [name, file]),
      [['Filters', `${SCHEMAS}/Filters.tsx`]],
    );
  });
});

describe('PC25: the ignore check', () => {
  const files = {
    '.gitignore': 'node_modules\n.doric\n',
    [`${SCHEMAS}/AppButton.tsx`]: entry('AppButton'),
  };

  test('a rule that hides the first entry file gives ignoredBy as <source>:<line>', async () => {
    const workspace = await library(files);

    const output = built(await libraryJob(workspace, { cwd: workspace.root }));

    assert.equal(output.ignoredBy, '.gitignore:2');
  });

  test('a library no rule hides has no ignoredBy', async () => {
    const workspace = await library({
      '.gitignore': 'node_modules\n',
      [`${SCHEMAS}/AppButton.tsx`]: entry('AppButton'),
    });

    const output = built(await libraryJob(workspace, { cwd: workspace.root }));

    assert.equal(output.ignoredBy, undefined);
  });

  test('a git that does not answer in 5 s gives none, and the job answers', {
    timeout: 60_000,
  }, async () => {
    const bin = await mkdtemp(join(tmpdir(), 'papercraft-slow-git-'));
    await writeFile(join(bin, 'git'), '#!/bin/sh\nsleep 6\nexit 0\n');
    await chmod(join(bin, 'git'), 0o755);
    const workspace = await library(files, { pathPrefix: bin });

    const startedAt = Date.now();
    const output = built(await libraryJob(workspace, { cwd: workspace.root }));

    assert.equal(output.ignoredBy, undefined);
    assert.ok(Date.now() - startedAt < 30_000);
  });

  test('no git on PATH gives none, and the job answers', async () => {
    const workspace = await library(files, {
      path: '/nonexistent-papercraft-bin',
    });

    const output = built(await libraryJob(workspace, { cwd: workspace.root }));

    assert.equal(output.ignoredBy, undefined);
  });
});
