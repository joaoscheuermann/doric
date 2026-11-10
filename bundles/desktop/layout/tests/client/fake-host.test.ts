// The stories' fake host as the layout's client tests rely on it (T-2.15):
// `whenAvailable` answers what `use` answers and nothing it does not, an id
// listed in `absent` is unknown to it, and `executed()` reports the commands
// run through `commands/v1`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CommandsV1, ref } from 'bundle/contracts';

import { createFakeHost } from '../../stories/support/fake-host.js';

const AboutV1 = ref<{
  get(): Promise<{ readonly version: string }>;
}>('doric.about/v1');

test('whenAvailable calls back once, synchronously, with the about answer use returns', async () => {
  const { services } = createFakeHost();
  const answers: unknown[] = [];

  const watch = services.whenAvailable(AboutV1, (api) => {
    answers.push(api);
  });

  assert.equal(answers.length, 1);
  assert.equal(answers[0], services.use(AboutV1));
  assert.deepEqual(await services.use(AboutV1).get(), { version: '0.0.1' });
  watch.dispose();
});

test('whenAvailable never calls back for an absent id', () => {
  const { services } = createFakeHost({ absent: ['doric.about/v1'] });
  let calls = 0;

  const watch = services.whenAvailable(AboutV1, () => {
    calls += 1;
  });

  assert.equal(calls, 0);
  watch.dispose();
});

test("disposing a whenAvailable runs the callback's cleanup at most once", () => {
  const { services } = createFakeHost();
  let cleanups = 0;

  const watch = services.whenAvailable(AboutV1, () => () => {
    cleanups += 1;
  });
  assert.equal(cleanups, 0);

  watch.dispose();
  watch.dispose();

  assert.equal(cleanups, 1);
});

test('use throws for an absent id', () => {
  const { services } = createFakeHost({ absent: ['doric.about/v1'] });

  assert.throws(() => services.use(AboutV1));
});

test('executed records the executed command ids in order, in a fresh array each call', async () => {
  const host = createFakeHost();
  const commands = host.services.use(CommandsV1);
  const before = host.executed();

  await commands.execute('core.open-settings/v1', {});
  await commands.execute(ref('core.other/v1'), {});
  const first = host.executed();
  await commands.execute('core.open-settings/v1', {});

  assert.deepEqual(before, []);
  assert.deepEqual(first, ['core.open-settings/v1', 'core.other/v1']);
  assert.deepEqual(host.executed(), [
    'core.open-settings/v1',
    'core.other/v1',
    'core.open-settings/v1',
  ]);
  assert.notEqual(host.executed(), host.executed());
});
