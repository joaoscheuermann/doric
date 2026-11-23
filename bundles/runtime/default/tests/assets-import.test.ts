import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * No module of the host part reads an asset (a template or a built-in agent
 * file) when it is imported: the bundled `main.mjs` has no file beside it, and
 * a read at import kills the process before it can install the texts. Each
 * module is imported in a fresh process from a copy of the compiled `src`
 * without its `*.md` files; reading an asset there fails with ENOENT, so an
 * import that succeeds read none, and a call that fails with ENOENT read on
 * first use.
 */

/** The compiled tests' folder: bundles/runtime/default/dist-tests. */
const distTests = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A copy of the compiled `src` without any `*.md`, inside `dist-tests` so the
 * workspace packages still resolve from it; removed after the test.
 */
const withoutAssets = (t: test.TestContext): string => {
  const root = mkdtempSync(join(distTests, 'no-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(distTests, 'src'), join(root, 'src'), {
    recursive: true,
    filter: (source) => !source.endsWith('.md'),
  });
  return join(root, 'src', 'host');
};

/** Runs `script` (an ES module) in a fresh node with `argv[1]` the host folder's URL. */
const run = (host: string, script: string) => {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, pathToFileURL(`${host}/`).href],
    { encoding: 'utf8' },
  );
  return { status, stdout: stdout.trim(), stderr };
};

/** The host part's modules, relative to `src/host`: the kernel entry and every module that reads an asset. */
const modules = [
  'index.js',
  'executor.js',
  'compact.js',
  'agents/built-in.js',
  'agents/catalog.js',
  'agents/definitions.js',
  'agents/live.js',
  'skills/catalog.js',
  'skills/live.js',
  'skills/load-skill.js',
  'skills/loaded.js',
  'assets.js',
  'ports.js',
];

for (const module of modules) {
  void test(`importing ${module} reads no asset file`, (t) => {
    const host = withoutAssets(t);

    const { status, stdout, stderr } = run(
      host,
      `await import(new URL(${JSON.stringify(module)}, process.argv[1]).href);
console.log('imported');`,
    );

    assert.equal(stdout, 'imported', stderr);
    assert.equal(status, 0);
  });
}

/** A script that calls `expression` (with `host` the imported module) and prints the code and message it throws. */
const failureOf = (module: string, expression: string): string =>
  `const host = await import(new URL(${JSON.stringify(module)}, process.argv[1]).href);
try {
  ${expression};
  console.log(JSON.stringify({ threw: false }));
} catch (error) {
  console.log(JSON.stringify({ threw: true, code: error.code, message: error.message }));
}`;

void test('builtInAgentFiles() reads the agent files on its call, not at import', (t) => {
  const host = withoutAssets(t);

  const { stdout, stderr } = run(
    host,
    failureOf('agents/built-in.js', 'host.builtInAgentFiles()'),
  );

  assert.notEqual(stdout, '', stderr);
  const answer = JSON.parse(stdout) as {
    threw: boolean;
    code?: string;
    message?: string;
  };
  assert.equal(answer.threw, true);
  assert.equal(answer.code, 'ENOENT');
  assert.match(answer.message ?? '', /triage\.md/u);
});

void test('systemPromptWith reads system.md on its first call, not at import', (t) => {
  const host = withoutAssets(t);

  const { stdout, stderr } = run(
    host,
    failureOf(
      'executor.js',
      "host.systemPromptWith({ date: '2026-03-01', timezone: 'UTC' }, '')",
    ),
  );

  assert.notEqual(stdout, '', stderr);
  const answer = JSON.parse(stdout) as {
    threw: boolean;
    code?: string;
    message?: string;
  };
  assert.equal(answer.threw, true);
  assert.equal(answer.code, 'ENOENT');
  assert.match(answer.message ?? '', /system\.md/u);
});
