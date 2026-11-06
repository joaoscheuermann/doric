// PC18, PC33 (D28): the `papercraft` skill. Its committed text is at most
// 8,000 characters and its first rule names `openui`; the host registers it
// with order 3410 and `allowedTools: ['comment_reply']` only while the
// Generative UI setting is on; a registration that fails (`unavailable_tool`)
// is caught, no skill is listed, and fences still draw.
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

describe('PC18: the registration follows the setting', () => {
  test('with the setting off no papercraft skill is registered', async () => {
    const host = await start({ enabled: false });

    assert.deepEqual(live(host), []);
  });

  test('with the setting on it is registered with order 3410 and comment_reply; off disposes it', async () => {
    const host = await start({ enabled: false });
    const text = await readFile(SKILL_FILE, 'utf8');

    host.writeSetting(true);
    await settle();

    const [registered, ...rest] = live(host);
    assert.equal(rest.length, 0);
    assert.ok(registered, 'the papercraft skill is registered');
    assert.deepEqual(registered.options, {
      order: 3410,
      alwaysAvailable: false,
    });
    assert.deepEqual(registered.skill.allowedTools, ['comment_reply']);
    assert.equal(registered.skill.body, text.trim());

    host.writeSetting(false);
    await settle();
    assert.deepEqual(live(host), []);
  });

  test('a stored true registers it at activation', async () => {
    const host = await start({ enabled: true });

    assert.equal(live(host).length, 1);
  });
});

describe('PC33: without comment_reply', () => {
  test('the unavailable_tool failure is caught, no skill is listed, and fences still draw', async () => {
    const host = await start({
      enabled: true,
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
    // Stage 3: with the setting on, the old preview tool is withheld.
    assert.ok(
      !host.tools.includes('papercraft_preview'),
      host.tools.join(', '),
    );
  });
});
