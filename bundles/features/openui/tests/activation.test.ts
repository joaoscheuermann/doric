// B10′ (openui.md D24, stage 4): no setting governs the `openui` skill any
// more. Activation registers it as D17 states it — name, description, no
// allowed tools, order 3400 — and the bundle's cleanup disposes it.
//
// The world is given a stored `false` for the old `openui.generative-ui/v1`
// space through an untyped option, so this file still compiles once the world
// drops that option, and proves the old value is never read.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { activateHost, type HostWorld, settle } from './support/host.js';

/** The committed skill text (D17), beside the sources; tests run from `dist-tests/tests`. */
const SKILL_FILE = new URL('../../src/host/skills/openui.md', import.meta.url);

const DESCRIPTION =
  'Answers with UI the app draws while you write: OpenUI Lang programs in openui-lang fences, with forms, tables, charts and question forms for the reader. Load it before writing an openui-lang or papercraft fence, or before asking the reader to decide something.';

/** The old space as a reader who turned it off stored it. */
const withOldSettingOff = {
  settings: { 'openui.generative-ui/v1': { enabled: false } },
} as Record<string, unknown>;

const worlds: HostWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.deactivate();
});

const start = async (): Promise<HostWorld> => {
  const world = await activateHost(
    withOldSettingOff as Parameters<typeof activateHost>[0],
  );
  worlds.push(world);
  return world;
};

const liveOpenui = (world: HostWorld) =>
  world.skills.filter(
    ({ skill, disposed }) => skill.name === 'openui' && !disposed,
  );

test('B10′: activation registers the openui skill as D17 states it, whatever the old setting holds', async () => {
  const world = await start();
  await settle();
  const text = await readFile(SKILL_FILE, 'utf8');

  const live = liveOpenui(world);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.skill.name, 'openui');
  assert.equal(live[0]?.skill.description, DESCRIPTION);
  assert.deepEqual(live[0]?.skill.allowedTools, []);
  assert.equal(live[0]?.skill.body, text.trim());
  assert.deepEqual(live[0]?.options, { order: 3400, alwaysAvailable: false });
});

test('B10′: the bundle cleanup disposes the skill', async () => {
  const world = await start();
  await settle();
  assert.equal(liveOpenui(world).length, 1, 'registered at activation');

  await worlds.splice(worlds.indexOf(world), 1)[0]?.deactivate();

  assert.deepEqual(liveOpenui(world), []);
});
