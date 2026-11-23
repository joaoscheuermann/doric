import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * The kernel host stages only a bundle's built `dist` (`stageBundles`, the
 * bundle build CLI): `<dest>/<id>` holds `host/assets.js`, `host/prompts/*.md`
 * and `host/agents/*.md`, with no `src/` anywhere. Without installed texts,
 * `assetText` reads each `defaultAssetPaths` entry from the copies the build
 * puts beside the module, so every entry reads from the staged bundle, and
 * `builtInAgentFiles()` answers the ten built-in agents.
 */

/** The compiled tests' folder: bundles/runtime/default/dist-tests. */
const distTests = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundleRoot = join(distTests, '..');
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The build CLI's `stageBundles`, loaded from the built `bundle` package. */
const stageBundles = async (
  destination: string,
  bundleDirs: readonly string[],
): Promise<void> => {
  const cli = (await import(
    pathToFileURL(
      join(workspaceRoot, 'packages', 'bundle', 'dist', 'build', 'cli.js'),
    ).href
  )) as {
    readonly stageBundles: (
      dest: string,
      dirs: readonly string[],
    ) => Promise<void>;
  };

  await cli.stageBundles(destination, bundleDirs);
};

/**
 * Stages the built bundle the way the kernel host does, into a temporary
 * folder inside `dist-tests` (removed after the test), and answers the staged
 * bundle's `host` folder.
 */
const stagedHost = async (t: test.TestContext): Promise<string> => {
  const root = mkdtempSync(join(distTests, 'staged-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await stageBundles(root, [bundleRoot]);
  return join(root, 'default', 'host');
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

/** The source text of a bundle-relative asset path. */
const sourceText = (path: string): string =>
  readFileSync(join(bundleRoot, path), 'utf8');

void test('a staged bundle (dist only, no src) reads every default asset and the built-in agents without installed texts', async (t) => {
  const host = await stagedHost(t);

  const { status, stdout, stderr } = run(
    host,
    `const assets = await import(new URL('assets.js', process.argv[1]).href);
const builtIn = await import(new URL('agents/built-in.js', process.argv[1]).href);
try {
  const texts = assets.defaultAssetPaths.map((path) => [path, assets.assetText(path)]);
  const agents = builtIn.builtInAgentFiles();
  console.log(JSON.stringify({ threw: false, texts, agents }));
} catch (error) {
  console.log(JSON.stringify({ threw: true, code: error.code, message: error.message }));
}`,
  );

  assert.notEqual(stdout, '', stderr);
  assert.equal(status, 0, stderr);
  const answer = JSON.parse(stdout) as {
    threw: boolean;
    code?: string;
    message?: string;
    texts?: [string, string][];
    agents?: { path: string; text: string }[];
  };
  assert.equal(
    answer.threw,
    false,
    `${answer.code ?? ''}: ${answer.message ?? ''}`,
  );

  const texts = answer.texts ?? [];
  assert.equal(texts.length, 17);
  for (const [path, text] of texts) {
    assert.equal(text, sourceText(path), path);
  }

  assert.deepEqual(
    (answer.agents ?? []).map(({ path }) => path),
    [
      'triage',
      'search',
      'spec',
      'review',
      'plan',
      'contracts',
      'tests',
      'implementation',
      'cleanup',
      'docs',
    ].map((name) => `src/host/agents/${name}.md`),
  );
  for (const { path, text } of answer.agents ?? []) {
    assert.equal(text, sourceText(path), path);
  }
});
