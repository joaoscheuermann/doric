import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * `stageBundles` (the bundle build CLI) stages only a bundle's built `dist`:
 * `<dest>/<id>` holds `host/assets.js`, `host/prompts/*.md` and
 * `host/agents/*.md`, with no `src/` anywhere. Since S68d `assetText` has no
 * disk fallback: without installed texts it reads none of the copies beside
 * the module, and every `defaultAssetPaths` entry, like `builtInAgentFiles()`,
 * throws an Error naming the asset (the host part installs the texts from
 * `host.assets` at `activate`).
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

void test('a staged bundle (dist only, no src) reads no default asset and no built-in agent from disk without installed texts', async (t) => {
  const host = await stagedHost(t);

  const { status, stdout, stderr } = run(
    host,
    `const assets = await import(new URL('assets.js', process.argv[1]).href);
const builtIn = await import(new URL('agents/built-in.js', process.argv[1]).href);
const outcome = (read) => {
  try {
    read();
    return { threw: false };
  } catch (error) {
    return { threw: true, code: error.code, message: error.message };
  }
};
console.log(JSON.stringify({
  texts: assets.defaultAssetPaths.map((path) => [path, outcome(() => assets.assetText(path))]),
  agents: outcome(() => builtIn.builtInAgentFiles()),
}));`,
  );

  assert.notEqual(stdout, '', stderr);
  assert.equal(status, 0, stderr);
  interface Outcome {
    readonly threw: boolean;
    readonly code?: string;
    readonly message?: string;
  }
  const answer = JSON.parse(stdout) as {
    texts: [string, Outcome][];
    agents: Outcome;
  };

  assert.equal(answer.texts.length, 17);
  for (const [path, outcome] of answer.texts) {
    assert.equal(outcome.threw, true, path);
    assert.equal(outcome.code, undefined, path);
    assert.ok(outcome.message?.includes(path), path);
  }
  assert.equal(answer.agents.threw, true);
  assert.equal(answer.agents.code, undefined);
  assert.ok(answer.agents.message?.includes('src/host/agents/triage.md'));
});
