// B10 and B18 (openui.md D17, D24): the Generative UI setting in the host.
// The `openui.generative-ui/v1` space reads `false` until written; windows
// read and write it through `openui.setting/v1`; the `openui` skill exists
// only while it is on.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import {
  type GenerativeUiSetting,
  generativeUiSetting,
  OpenuiSettingV1,
} from '../src/contracts/index.js';
import { activateHost, type HostWorld, settle } from './support/host.js';

/** The committed skill text (D17), beside the sources; tests run from `dist-tests/tests`. */
const SKILL_FILE = new URL('../../src/host/skills/openui.md', import.meta.url);

const DESCRIPTION =
  'Answers with UI the app draws while you write: OpenUI Lang programs in openui-lang fences, with forms, tables, charts and question forms for the reader. Load it before writing an openui-lang or papercraft fence, or before asking the reader to decide something.';

const worlds: HostWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.deactivate();
});

const start = async (
  settings?: Readonly<Record<string, unknown>>,
): Promise<HostWorld> => {
  const world = await activateHost(settings === undefined ? {} : { settings });
  worlds.push(world);
  return world;
};

const liveOpenui = (world: HostWorld) =>
  world.skills.filter(
    ({ skill, disposed }) => skill.name === 'openui' && !disposed,
  );

test('B10: with the setting off the openui skill is not listed', async () => {
  const world = await start();
  await settle();

  assert.deepEqual(liveOpenui(world), []);
  assert.ok(world.registeredSpaces.includes(generativeUiSetting.id));
});

test('B10: turning the setting on registers the skill as D17 states, and turning it off disposes it', async () => {
  const world = await start();
  const setting = world.test.services.use(OpenuiSettingV1);
  const text = await readFile(SKILL_FILE, 'utf8');

  await setting.set({ enabled: true });
  await settle();

  const live = liveOpenui(world);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.skill.name, 'openui');
  assert.equal(live[0]?.skill.description, DESCRIPTION);
  assert.deepEqual(live[0]?.skill.allowedTools, []);
  assert.equal(live[0]?.skill.body, text.trim());
  assert.deepEqual(live[0]?.options, { order: 3400, alwaysAvailable: false });

  await setting.set({ enabled: false });
  await settle();

  assert.deepEqual(liveOpenui(world), []);
  assert.equal(
    world.skills.filter(({ skill }) => skill.name === 'openui').length,
    1,
  );
});

test('B10: a stored true registers the skill at activation, and a write through settings/v1 is followed', async () => {
  const world = await start({ [generativeUiSetting.id]: { enabled: true } });
  await settle();

  assert.equal(liveOpenui(world).length, 1);

  world.writeSetting(generativeUiSetting.id, { enabled: false });
  await settle();
  assert.deepEqual(liveOpenui(world), []);

  world.writeSetting(generativeUiSetting.id, { enabled: true });
  await settle();
  assert.equal(liveOpenui(world).length, 1);
});

test('B18: get reads false for a space never written', async () => {
  const world = await start();

  assert.deepEqual(await world.test.services.use(OpenuiSettingV1).get(), {
    enabled: false,
  });
});

test('B18: set stores the value and watch reports it to every listener', async () => {
  const world = await start();
  const setting = world.test.services.use(OpenuiSettingV1);
  const first: GenerativeUiSetting[] = [];
  const second: GenerativeUiSetting[] = [];

  const one = setting.watch((value) => {
    first.push(value);
  });
  const two = setting.watch((value) => {
    second.push(value);
  });
  await settle();

  assert.deepEqual(await setting.set({ enabled: true }), { enabled: true });
  await settle();

  assert.deepEqual(await setting.get(), { enabled: true });
  assert.deepEqual(first, [{ enabled: false }, { enabled: true }]);
  assert.deepEqual(second, [{ enabled: false }, { enabled: true }]);

  one.dispose();
  two.dispose();
});

test('B18: a value written through settings/v1 is reported by watch too', async () => {
  const world = await start();
  const seen: GenerativeUiSetting[] = [];
  const watch = world.test.services.use(OpenuiSettingV1).watch((value) => {
    seen.push(value);
  });
  await settle();

  world.writeSetting(generativeUiSetting.id, { enabled: true });
  await settle();

  assert.deepEqual(seen, [{ enabled: false }, { enabled: true }]);
  watch.dispose();
});

test('B18: set refuses a value that is not a setting', async () => {
  const world = await start();

  await assert.rejects(
    async () =>
      world.test.services
        .use(OpenuiSettingV1)
        .set({ enabled: 'yes' } as unknown as GenerativeUiSetting),
    { code: 'invalid_input' },
  );
});
