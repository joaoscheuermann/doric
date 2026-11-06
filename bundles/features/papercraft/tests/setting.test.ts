// B22 (openui.md D24, stage 3): papercraft follows the Generative UI setting
// with its old preview path. While the setting is off it registers the
// `papercraft_preview` tool and then the `papercraft-preview` skill, whose
// body is `src/host/skills/papercraft-preview.md`, first in its
// `onHostStartHook` handler; while it is on it disposes the skill and then
// the tool. `skills/v1` applies the core's rule: an `allowedTools` entry that
// names no live tool raises `unavailable_tool`.
//
// Over the real host entry (`src/host/index.ts`) activated on the fakes of
// `tests/support/host.ts`; the tools other bundles register (`comment_reply`,
// `write`, `edit`) are live once every bundle has loaded.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, test } from 'node:test';

import {
  type ActiveHost,
  type RegistryStep,
  settle,
  type World,
  world,
} from './support/host.js';

/** The moved skill text, beside the sources; tests run from `dist-tests/tests`. */
const SKILL_FILE = new URL(
  '../../src/host/skills/papercraft-preview.md',
  import.meta.url,
);

const TOOL = 'papercraft_preview';
const SKILL = 'papercraft-preview';
const DESCRIPTION =
  'Publishes a visual change as a live preview node of the conversation, built from real code, instead of describing it. Use when the change is easier to judge by looking than by reading a diff, and the user should see it, comment on it and steer it.';

const running: { world: World; host?: ActiveHost }[] = [];

afterEach(async () => {
  for (const entry of running.splice(0)) {
    await entry.host?.deactivate();
    await entry.world.dispose();
  }
});

/** Activates the host with the setting as stored, then fires host start. */
const start = async (enabled: boolean) => {
  const entry: { world: World; host?: ActiveHost } = {
    world: world({ enabled, otherTools: ['comment_reply', 'write', 'edit'] }),
  };
  running.push(entry);
  const host = await entry.world.activate();
  entry.host = host;
  await settle();
  return { world: entry.world, host };
};

const liveSkills = (host: World, name: string) =>
  host.skills.filter(({ skill, disposed }) => skill.name === name && !disposed);

const liveTools = (host: World, name: string) =>
  host.toolRegistrations.filter(
    (entry) => entry.name === name && !entry.disposed,
  );

/** The steps of the old preview path only, from `from` on. */
const previewSteps = (host: World, from = 0): RegistryStep[] =>
  host.registry
    .slice(from)
    .filter(({ name }) => name === TOOL || name === SKILL);

/** The `unavailable_tool` errors the papercraft-preview skill met. */
const previewSkillErrors = (host: World) =>
  host.skillErrors
    .map(({ message }) => message)
    .filter((message) => message.includes(`"${SKILL}"`));

const turn = async (host: World, enabled: boolean) => {
  host.writeSetting(enabled);
  await settle();
};

describe('B22: the old preview path follows the setting', () => {
  test('with the setting on, neither papercraft_preview nor papercraft-preview is live after host start', async () => {
    const { world: host, host: active } = await start(true);
    await active.hostStart();
    await settle();

    assert.deepEqual(liveTools(host, TOOL), []);
    assert.deepEqual(liveSkills(host, SKILL), []);
  });

  test('turning the setting off registers papercraft_preview before papercraft-preview and raises no unavailable_tool', async () => {
    const { world: host, host: active } = await start(true);
    await active.hostStart();
    await settle();
    const text = await readFile(SKILL_FILE, 'utf8');
    const mark = host.registry.length;

    await turn(host, false);

    assert.deepEqual(previewSkillErrors(host), []);
    assert.deepEqual(
      previewSteps(host, mark).filter(({ action }) => action === 'register'),
      [
        { action: 'register', kind: 'tool', name: TOOL },
        { action: 'register', kind: 'skill', name: SKILL },
      ],
    );

    const [tool, ...otherTools] = liveTools(host, TOOL);
    assert.equal(otherTools.length, 0);
    assert.deepEqual(tool?.options, { alwaysAvailable: true, order: 1700 });

    const [skill, ...otherSkills] = liveSkills(host, SKILL);
    assert.equal(otherSkills.length, 0);
    assert.equal(skill?.skill.name, SKILL);
    assert.equal(skill?.skill.description, DESCRIPTION);
    assert.deepEqual(skill?.skill.allowedTools, [
      'papercraft_preview',
      'comment_reply',
      'write',
      'edit',
    ]);
    assert.equal(skill?.skill.body, text.trim());
    assert.deepEqual(skill?.options, { order: 3400, alwaysAvailable: false });
  });

  test('turning it on again disposes both, the skill first', async () => {
    const { world: host, host: active } = await start(true);
    await active.hostStart();
    await settle();
    await turn(host, false);
    const mark = host.registry.length;

    await turn(host, true);

    assert.deepEqual(previewSteps(host, mark), [
      { action: 'dispose', kind: 'skill', name: SKILL },
      { action: 'dispose', kind: 'tool', name: TOOL },
    ]);
    assert.deepEqual(liveTools(host, TOOL), []);
    assert.deepEqual(liveSkills(host, SKILL), []);
  });

  test('off and on twice leaves exactly one registration of each while off', async () => {
    const { world: host, host: active } = await start(true);
    await active.hostStart();
    await settle();

    await turn(host, false);
    await turn(host, true);
    await turn(host, false);
    await turn(host, true);
    await turn(host, false);

    assert.deepEqual(previewSkillErrors(host), []);
    assert.equal(liveTools(host, TOOL).length, 1);
    assert.equal(liveSkills(host, SKILL).length, 1);
  });

  test('with a stored false, host start registers papercraft_preview and then papercraft-preview, raising no unavailable_tool', async () => {
    const { world: host, host: active } = await start(false);

    assert.deepEqual(
      liveSkills(host, SKILL),
      [],
      'the skill first registers in onHostStartHook',
    );

    await active.hostStart();
    await settle();

    assert.deepEqual(previewSkillErrors(host), []);
    assert.equal(liveTools(host, TOOL).length, 1);
    assert.equal(liveSkills(host, SKILL).length, 1);
    const registers = previewSteps(host).filter(
      ({ action }) => action === 'register',
    );
    assert.deepEqual(registers.at(-1), {
      action: 'register',
      kind: 'skill',
      name: SKILL,
    });
    assert.ok(
      registers.findIndex(({ kind }) => kind === 'tool') <
        registers.findIndex(({ kind }) => kind === 'skill'),
      JSON.stringify(registers),
    );
  });
});
