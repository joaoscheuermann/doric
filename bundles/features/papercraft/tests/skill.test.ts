// PC18, PC33 (D28): the `papercraft` skill. Its committed text is at most
// 8,000 characters and its first rule names `openui`; the host registers it
// at activation with order 3410 and `allowedTools: ['comment_reply']`; a
// registration that fails (`unavailable_tool`) is caught, no skill is listed,
// and fences still draw.
//
// Over the real host entry (`src/host/index.ts`) activated on the fakes of
// `tests/support/host.ts`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import { PapercraftProgramsV1 } from '../src/contracts/index.js';
import {
  type ActiveHost,
  projectId,
  settle,
  type World,
  type WorldOptions,
  world,
} from './support/host.js';

/** The committed skill text, beside the sources; tests run from `dist-tests/tests`. */
const SKILL_FILE = new URL(
  '../../src/host/skills/papercraft.md',
  import.meta.url,
);

const running: { world: World; host?: ActiveHost }[] = [];

afterEach(async () => {
  for (const entry of running.splice(0)) {
    await entry.host?.deactivate();
    await entry.world.dispose();
  }
});

const start = async (options: WorldOptions = {}) => {
  const entry: { world: World; host?: ActiveHost } = { world: world(options) };
  running.push(entry);
  entry.host = await entry.world.activate();
  await settle();
  return entry.world;
};

const live = (host: World) =>
  host.skills.filter(
    ({ skill, disposed }) => skill.name === 'papercraft' && !disposed,
  );

describe('PC18: the skill text', () => {
  test('is at most 8,000 characters and its first rule names openui', async () => {
    const text = await readFile(SKILL_FILE, 'utf8');

    assert.ok(text.length <= 8_000, String(text.length));
    const firstRule = text
      .split('\n')
      .find((line) => /^\s*(?:[-*]|\d+\.)\s+/u.test(line));
    assert.ok(firstRule, 'the text has rules');
    assert.match(firstRule, /`openui`/u);
  });
});

// PC36 (D28, U51, stage 5): after the patch example of "The papercraft
// fence" and before `## Export`, the skill says word for word that a fence
// with an earlier identity is a patch and a new program is written whole;
// the text stays within PC18's 8,000 characters.
describe('PC36: the patch rule', () => {
  const paragraph =
    'A fence with the same identity as an earlier fence is a patch: the app merges it into that program. A new program, under a new identity or without one, is always written whole and starts with its root statement, `root = …`. Never send a patch, or any fragment without `root`, as a new program: the app draws nothing for it.';

  test('the paragraph follows the patch example, before Export, within 8,000 characters', async () => {
    const text = await readFile(SKILL_FILE, 'utf8');

    const at = text.indexOf(`\n${paragraph}\n`);
    assert.ok(at >= 0, 'the paragraph is present, word for word, on its own line');
    const patchExample = text.indexOf('A later change to its form:');
    assert.ok(patchExample >= 0, 'the patch example is present');
    const patchEnd = text.indexOf('\n```\n', text.indexOf('```papercraft', patchExample));
    assert.ok(patchEnd >= 0 && at > patchEnd, 'after the patch example');
    const exportAt = text.indexOf('\n## Export\n');
    assert.ok(exportAt >= 0 && at < exportAt, 'before ## Export');
    assert.ok(text.length <= 8_000, String(text.length));
  });
});

// PC18 (D25, stage 4): no setting governs the skill any more. Activation
// registers it, before any host start, and cleanup disposes it. The world is
// given a stored `false` for the old setting through an untyped option, so
// the test still compiles once the world drops that option, and proves the
// old value is never read.
describe('PC18: the registration at activation', () => {
  const withOldSettingOff = { enabled: false } as Record<string, unknown>;

  test('activation registers it with order 3410 and comment_reply, whatever the old setting holds', async () => {
    const host = await start(withOldSettingOff as WorldOptions);
    const text = await readFile(SKILL_FILE, 'utf8');

    const [registered, ...rest] = live(host);
    assert.equal(rest.length, 0);
    assert.ok(registered, 'the papercraft skill is registered at activation');
    assert.deepEqual(registered.options, {
      order: 3410,
      alwaysAvailable: false,
    });
    assert.deepEqual(registered.skill.allowedTools, ['comment_reply']);
    assert.equal(registered.skill.body, text.trim());
  });

  test('cleanup disposes it', async () => {
    const entry: { world: World; host?: ActiveHost } = {
      world: world(withOldSettingOff as WorldOptions),
    };
    running.push(entry);
    const active = await entry.world.activate();
    await settle();
    assert.equal(live(entry.world).length, 1, 'registered at activation');

    await active.deactivate();
    await settle();

    assert.deepEqual(live(entry.world), []);
  });
});

describe('PC33: without comment_reply', () => {
  test('the unavailable_tool failure is caught, no skill is listed, and fences still draw', async () => {
    const host = await start({
      skillError: new ContractError(
        'unavailable_tool',
        'comment_reply is not a registered tool',
      ),
    });

    assert.deepEqual(live(host), []);
    // The host still serves the fences: a Thread with no cwd event has no library.
    assert.deepEqual(
      await host.test.services
        .use(PapercraftProgramsV1, { projectId, threadId: 'thread-1' })
        .library({ turnSequence: 1 }),
      { status: 'none' },
    );
  });
});
