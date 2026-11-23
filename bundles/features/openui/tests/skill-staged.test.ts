// S1–S2 (phase 3, S56, D4): the kernel host stages only a bundle's built
// `dist` (`stageBundles`, the bundle build CLI): `<dest>/openui` holds
// `host/skill.js`, `host/index.js` and `host/skills/openui.md`, with no `src/`
// anywhere. The skill text is read beside the module, in `activate`, never at
// import: a staged bundle reads it, and one whose `host/skills/` is gone still
// imports and fails only when it activates.

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

/** The compiled tests' folder: bundles/features/openui/dist-tests. */
const distTests = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundleRoot = join(distTests, '..');
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The committed skill text. */
const skillText = (): string =>
  readFileSync(join(bundleRoot, 'src', 'host', 'skills', 'openui.md'), 'utf8');

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
  return join(root, 'openui', 'host');
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
    bundle: { id: 'openui' },
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

void test('S1: in a staged bundle readSkillBesideModule reads the committed skill text, and the staged kernel entry registers it', async (t) => {
  const host = await stagedHost(t);

  const { status, stdout, stderr } = run(
    host,
    `const skill = await import(new URL('skill.js', process.argv[1]).href);
try {
  console.log(JSON.stringify({ threw: false, text: skill.readSkillBesideModule() }));
} catch (error) {
  console.log(JSON.stringify({ threw: true, code: error.code, message: error.message }));
}`,
  );

  assert.notEqual(stdout, '', stderr);
  assert.equal(status, 0, stderr);
  const answer = JSON.parse(stdout) as {
    threw: boolean;
    text?: string;
    code?: string;
    message?: string;
  };
  assert.equal(
    answer.threw,
    false,
    `${answer.code ?? ''}: ${answer.message ?? ''}`,
  );
  assert.equal(answer.text, skillText());

  const skills = await activateStaged(host);

  assert.deepEqual(
    skills.map(({ name, body }) => ({ name, body })),
    [{ name: 'openui', body: skillText().trim() }],
  );
});

void test('S2: without the staged host/skills/, index.js and skill.js still import, and activate then throws ENOENT', async (t) => {
  const host = await stagedHost(t);
  await rm(join(host, 'skills'), { recursive: true, force: true });

  for (const module of ['index.js', 'skill.js']) {
    const { stdout, stderr } = run(
      host,
      `await import(new URL(${JSON.stringify(module)}, process.argv[1]).href);
console.log('imported');`,
    );

    assert.equal(stdout, 'imported', `${module}: ${stderr}`);
  }

  await assert.rejects(activateStaged(host), { code: 'ENOENT' });
});
