// S1–S2 (S57 D5, spec "Assets"): the kernel host stages only a bundle's
// built `dist` (`stageBundles`, the bundle build CLI): `<dest>/papercraft`
// holds `host/skill.js`, `host/sandbox.js`, `host/index.js`,
// `host/skills/papercraft.md` and `sandbox/runner.mjs`, with no `src/`
// anywhere. The skill text is read beside the module in `activate`, the
// runner at the first job, never at import: a staged bundle reads both, and
// one whose `host/skills/` and runner are gone still imports, fails to
// activate (`ENOENT`) and has no runner.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  type Activate,
  type AnyServiceDefinition,
  type Call,
  defineMethod,
  defineService,
  EventsV1,
  eventsMethods,
  HooksV1,
  hooksMethods,
  type SkillSchemaInput,
  SkillsV1,
  skillsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

/** The compiled tests' folder: bundles/features/papercraft/dist-tests. */
const distTests = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundleRoot = join(distTests, '..');
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The committed skill text. */
const skillText = (): string =>
  readFileSync(
    join(bundleRoot, 'src', 'host', 'skills', 'papercraft.md'),
    'utf8',
  );

/** The runner the build wrote. */
const builtRunner = (): Buffer =>
  readFileSync(join(bundleRoot, 'dist', 'sandbox', 'runner.mjs'));

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

/** Stages the built bundle into a folder inside `dist-tests` (removed after the test) and answers its `host` folder. */
const stagedHost = async (t: test.TestContext): Promise<string> => {
  const root = await mkdtemp(join(distTests, 'staged-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await stageBundles(root, [bundleRoot]);
  return join(root, 'papercraft', 'host');
};

/**
 * Runs `script` (an ES module) in a fresh node with `argv[1]` the host folder's URL.
 *
 * The buffer is far above the default 1 MiB because S1 prints the staged runner as base64.
 */
const run = (host: string, script: string) => {
  const { status, signal, error, stdout, stderr } = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, pathToFileURL(`${host}/`).href],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const failure = `status ${String(status)}, signal ${String(signal)}, error ${error?.message ?? 'none'}\n${stderr}`;
  return { status, stdout: (stdout ?? '').trim(), stderr, failure };
};

/** A provider whose methods answer through `handlers`; any other method throws. */
const fake = (
  id: string,
  specs: Readonly<
    Record<string, { readonly input: unknown; readonly output: unknown }>
  >,
  handlers: Readonly<Record<string, (input: never, call: Call) => unknown>>,
): AnyServiceDefinition =>
  defineService(
    id as `${string}/v${number}`,
    Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => [
        name,
        defineMethod({
          input: spec.input as never,
          output: spec.output as never,
          execute: ((input: never, call: Call) => {
            const handler = handlers[name];
            if (handler === undefined) {
              throw new Error(`The test fakes no ${id}.${name}.`);
            }
            return handler(input, call);
          }) as never,
        }),
      ]),
    ),
  );

const disposable = () => ({ dispose: () => undefined });

/** Imports the staged kernel entry and activates it over fakes; answers the skills it registered. */
const activateStaged = async (host: string): Promise<SkillSchemaInput[]> => {
  const skills: SkillSchemaInput[] = [];
  const test = createTestServices({
    bundle: { id: 'papercraft' },
    provide: [
      fake(EventsV1.id, eventsMethods, { register: disposable }),
      // runtime.hooks/v1 is never defined here: no hook handler runs.
      fake(HooksV1.id, hooksMethods, { whenDefined: disposable }),
      fake(SkillsV1.id, skillsMethods, {
        register: ([skill]: [SkillSchemaInput]) => {
          skills.push(skill);
          return disposable();
        },
      }),
    ],
  });
  try {
    const { activate } = (await import(
      pathToFileURL(join(host, 'index.js')).href
    )) as { readonly activate: Activate };
    const cleanup = await activate({ services: test.services });
    if (typeof cleanup === 'function') await cleanup();
    return skills;
  } finally {
    await test.dispose();
  }
};

/** Answers what `expression` (awaited in the staged host) gave, or how it threw. */
const evaluate = (
  host: string,
  module: string,
  expression: string,
): {
  readonly threw: boolean;
  readonly value?: unknown;
  readonly code?: string;
  readonly message?: string;
} => {
  const { status, stdout, failure } = run(
    host,
    `const m = await import(new URL(${JSON.stringify(module)}, process.argv[1]).href);
try {
  const value = await (${expression});
  console.log(JSON.stringify({ threw: false, value: value === undefined ? null : value }));
} catch (error) {
  console.log(JSON.stringify({ threw: true, code: error.code, message: error.message }));
}`,
  );

  assert.equal(status, 0, failure);
  assert.notEqual(stdout, '', failure);
  return JSON.parse(stdout) as {
    threw: boolean;
    value?: unknown;
    code?: string;
    message?: string;
  };
};

void test('S1: in a staged bundle the skill and the runner are read beside their modules, and the staged kernel entry registers the skill', async (t) => {
  const host = await stagedHost(t);

  const skill = evaluate(host, 'skill.js', 'm.readSkillBesideModule()');
  assert.equal(
    skill.threw,
    false,
    `${skill.code ?? ''}: ${skill.message ?? ''}`,
  );
  assert.equal(skill.value, skillText());

  const runner = evaluate(
    host,
    'sandbox.js',
    'm.readRunnerBesideModule().then((script) => script === undefined ? undefined : Buffer.from(script.bytes).toString("base64"))',
  );
  assert.equal(
    runner.threw,
    false,
    `${runner.code ?? ''}: ${runner.message ?? ''}`,
  );
  assert.equal(runner.value, builtRunner().toString('base64'));

  const skills = await activateStaged(host);

  assert.deepEqual(
    skills.map(({ name, body }) => ({ name, body })),
    [{ name: 'papercraft', body: skillText().trim() }],
  );
});

void test('S2: without the staged host/skills/ and runner, index.js, skill.js and sandbox.js still import, activate throws ENOENT and there is no runner', async (t) => {
  const host = await stagedHost(t);
  await rm(join(host, 'skills'), { recursive: true, force: true });
  await rm(join(host, '..', 'sandbox', 'runner.mjs'), { force: true });

  for (const module of ['index.js', 'skill.js', 'sandbox.js']) {
    const { stdout, stderr } = run(
      host,
      `await import(new URL(${JSON.stringify(module)}, process.argv[1]).href);
console.log('imported');`,
    );

    assert.equal(stdout, 'imported', `${module}: ${stderr}`);
  }

  await assert.rejects(activateStaged(host), { code: 'ENOENT' });

  const runner = evaluate(host, 'sandbox.js', 'm.readRunnerBesideModule()');
  assert.deepEqual(runner, { threw: false, value: null });
});
