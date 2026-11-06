// B10, B12, B18 and B23 (openui.md D17, D24) and C10 (conversation-openui.md
// D30): the Generative UI setting in the host. The `openui.generative-ui/v1`
// space reads `true` until written (1.1.0) and a stored `false` stays `false`;
// windows read and write it through `openui.setting/v1`; the `openui` skill
// exists only while it is on, and while it is on `openui` withholds `threads`'
// `ask` through `threads.ask/v1.withholdTool`.

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
  ask?: 'available' | 'unavailable',
): Promise<HostWorld> => {
  const world = await activateHost({
    ...(settings === undefined ? {} : { settings }),
    ...(ask === undefined ? {} : { ask }),
  });
  worlds.push(world);
  return world;
};

/** A space a reader turned off, as stored (under 1.0.0 or later). */
const storedOff = { [generativeUiSetting.id]: { enabled: false } } as const;

/** The withholds that answered a Disposable and are not disposed. */
const liveWithholds = (world: HostWorld) =>
  world.withholds.filter(({ held, disposed }) => held && !disposed);

const liveOpenui = (world: HostWorld) =>
  world.skills.filter(
    ({ skill, disposed }) => skill.name === 'openui' && !disposed,
  );

test('B10: with the setting off the openui skill is not listed', async () => {
  const world = await start(storedOff);
  await settle();

  assert.deepEqual(liveOpenui(world), []);
  assert.ok(world.registeredSpaces.includes(generativeUiSetting.id));
});

test('B10: turning the setting on registers the skill as D17 states, and turning it off disposes it', async () => {
  const world = await start(storedOff);
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

test('B18: get reads true for a space never written', async () => {
  const world = await start();

  assert.deepEqual(await world.test.services.use(OpenuiSettingV1).get(), {
    enabled: true,
  });
});

test('B18: set stores the value and watch reports it to every listener', async () => {
  const world = await start(storedOff);
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
  const world = await start(storedOff);
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

test('B12: with no stored value the setting reads true and the openui skill is listed', async () => {
  const world = await start();
  await settle();

  assert.deepEqual(await world.test.services.use(OpenuiSettingV1).get(), {
    enabled: true,
  });
  assert.equal(liveOpenui(world).length, 1);
});

test('B12: a stored false stays false and the openui skill is not listed', async () => {
  const world = await start(storedOff);
  await settle();

  assert.deepEqual(await world.test.services.use(OpenuiSettingV1).get(), {
    enabled: false,
  });
  assert.deepEqual(liveOpenui(world), []);
});

test('B23: with openui activated before threads and the setting on, withholdTool is first called in onHostStartHook and ask is not listed after it', async () => {
  const world = await start(undefined, 'available');
  await settle();

  assert.equal(
    world.withholds.length,
    0,
    'no withholdTool call before host start',
  );
  assert.equal(world.askListed(), true);

  await world.hostStart();
  await settle();

  assert.equal(world.withholds.length, 1);
  assert.equal(liveWithholds(world).length, 1);
  assert.equal(world.askListed(), false);
});

test('B23: with the setting off at host start, withholdTool is not called and ask stays listed', async () => {
  const world = await start(storedOff, 'available');
  await world.hostStart();
  await settle();

  assert.equal(world.withholds.length, 0);
  assert.equal(world.askListed(), true);
});

test('B23: turning the setting off and on calls withholdTool again and holds one Disposable', async () => {
  const world = await start(undefined, 'available');
  await world.hostStart();
  await settle();

  world.writeSetting(generativeUiSetting.id, { enabled: false });
  await settle();
  assert.equal(liveWithholds(world).length, 0);

  world.writeSetting(generativeUiSetting.id, { enabled: true });
  await settle();
  assert.equal(world.withholds.length, 2);
  assert.equal(liveWithholds(world).length, 1);

  // A second value that is on while one is held calls nothing more.
  world.writeSetting(generativeUiSetting.id, { enabled: true });
  await settle();
  assert.equal(world.withholds.length, 2);
  assert.equal(liveWithholds(world).length, 1);
  assert.equal(world.askListed(), false);
});

test('B23: with no provider of threads.ask/v1, turning the setting on raises nothing and holds nothing', async () => {
  const world = await start(undefined, 'unavailable');

  await world.hostStart();
  await settle();
  assert.equal(
    world.withholds.length,
    1,
    'withholdTool was tried at host start',
  );
  assert.equal(liveWithholds(world).length, 0);

  world.writeSetting(generativeUiSetting.id, { enabled: false });
  await settle();
  world.writeSetting(generativeUiSetting.id, { enabled: true });
  await settle();
  assert.equal(
    world.withholds.length,
    2,
    'withholdTool was tried again at the next value on',
  );
  assert.equal(liveWithholds(world).length, 0);

  // Holding nothing, the next value that is on calls again, and now holds one.
  world.setAskAvailable(true);
  world.writeSetting(generativeUiSetting.id, { enabled: true });
  await settle();
  assert.equal(world.withholds.length, 3);
  assert.equal(liveWithholds(world).length, 1);
  assert.deepEqual(world.test.reports, []);
});

test('B23: with no bundle providing threads.ask/v1 at all, host start and setting changes raise nothing', async () => {
  const world = await start();

  await world.hostStart();
  world.writeSetting(generativeUiSetting.id, { enabled: false });
  await settle();
  world.writeSetting(generativeUiSetting.id, { enabled: true });
  await settle();

  assert.equal(liveOpenui(world).length, 1);
  assert.deepEqual(world.test.reports, []);
});

test('C10: with the setting on the withholdTool disposable is live; turning the setting off disposes it and ask is listed again', async () => {
  const world = await start(undefined, 'available');
  await world.hostStart();
  await settle();

  const [held, ...rest] = world.withholds;
  assert.equal(rest.length, 0);
  assert.equal(held?.held, true);
  assert.equal(held?.disposed, false);
  assert.equal(world.askListed(), false);

  world.writeSetting(generativeUiSetting.id, { enabled: false });
  await settle();

  assert.equal(held?.disposed, true);
  assert.equal(world.askListed(), true);
});
