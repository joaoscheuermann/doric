import assert from 'node:assert/strict';
import test from 'node:test';

import type { Call } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { kernelPorts } from '../src/host/ports.js';
import { skillCatalog } from '../src/host/skills/catalog.js';
import { loadSkillTool } from '../src/host/skills/load-skill.js';
import { readRunSkills, readSourceSkills } from '../src/host/skills/sources.js';
import {
  type FakeSkillSource,
  type LoggedEntry,
  logService,
  projectId,
  promptId,
  type RecordedCall,
  skillSourceService,
  skillsService,
  sourceEntry,
  threadId,
} from './support/harness.js';

/*
 * `default.skill-sources/v1` as an extension point (bundle isolation T8.1):
 * made-up bundles provide it, and `default` names, lists and reads their
 * skills without knowing who they are. `skills-sources.test.ts` covers where
 * a run's skills come from as a whole (skills/v1, the working directory's
 * scan, and the source `mcp` the shipped composition has); this file covers
 * what `default` promises any source: the `<bundleId>/<group>/<name>` ids,
 * the origin line, the 5,000 ms bound on `list` and none on `read`, the answer
 * checked against the contract, one warning per left-out source and prompt,
 * the provider order, and the reserved id `cwd`.
 */

const scope = { projectId, threadId, promptId };

/** Another prompt of the same Thread. */
const laterPromptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1604';

/** `value`, answered after `ms` milliseconds of the (mocked) clock. */
const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });

/** Lets every pending call reach its timers before the mocked clock moves. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/**
 * `default` beside a fake `log/v1`, a `skills/v1` with no skill, and one fake
 * source per entry of `sources`, provided in that order from a bundle of
 * that id.
 */
const world = (sources: Readonly<Record<string, FakeSkillSource>>) => {
  const logs: LoggedEntry[] = [];
  const calls: Record<string, RecordedCall[]> = {};
  const services = createTestServices({
    bundle: { id: 'default' },
    provide: [logService(logs), skillsService([])],
    providers: Object.entries(sources).map(([bundleId, source]) => {
      const recorded: RecordedCall[] = [];
      calls[bundleId] = recorded;
      return { bundleId, provide: [skillSourceService(source, recorded)] };
    }),
  });
  /** The Call of one prompt of the Thread; another id is another prompt. */
  const prompt = (id = promptId): Call =>
    services.call({ projectId, threadId, promptId: id });
  /** The catalog of one read of the run's skills in `/workspace`. */
  const catalog = async (call: Call = prompt()) =>
    skillCatalog(
      await readRunSkills('/workspace', call, kernelPorts(services.services)),
    );
  return {
    services,
    calls,
    prompt,
    catalog,
    /** The ids `load_skill` accepts after one read of the run's skills. */
    locators: async (call?: Call) => [...(await catalog(call)).listed.keys()],
    /** The `bundleId` of every warning logged so far, in order. */
    warned: () =>
      logs
        .filter(({ level }) => level === 'warn')
        .map(({ fields }) => fields?.bundleId),
    /** What `load_skill` answers for `name` in a run that read its skills. */
    load: async (name: string, call: Call = prompt()): Promise<string> => {
      const { listed } = await catalog(call);
      return String(
        await loadSkillTool(
          () => listed,
          () => [],
          call,
          kernelPorts(services.services),
        ).execute({ name }),
      );
    },
  };
};

const FMT_TEXT =
  '---\nname: fmt\ndescription: Format the code.\n---\n\n# Fmt\n\nRun the formatter.\n';

/** The made-up bundle `acme`: `fmt` in its group `tools`, and `lint` in none. */
const acme = (read?: FakeSkillSource['read']): FakeSkillSource => ({
  list: () => ({
    skills: [
      sourceEntry('fmt', {
        group: 'tools',
        description: 'Format the code.',
        reference: 'fmt-ref',
      }),
      sourceEntry('lint', {
        description: 'Lint the code.',
        reference: 'lint-ref',
      }),
    ],
  }),
  read:
    read ??
    (({ reference }) =>
      reference === 'fmt-ref'
        ? { origin: 'From the acme tools (`fmt-ref`).', text: FMT_TEXT }
        : { text: '# Lint\n\nRun the linter.' }),
});

/** A source listing one skill, `name`, without a group. */
const listing = (name: string): FakeSkillSource => ({
  list: () => ({ skills: [sourceEntry(name)] }),
});

void test('S1 names a source skill <bundleId>/<group>/<name>, or <bundleId>/<name> without a group, and asks the source with the prompt working directory', async () => {
  const { catalog, calls } = world({ acme: acme() });

  const { listed, section } = await catalog();

  assert.deepEqual([...listed.keys()], ['acme/tools/fmt', 'acme/lint']);
  assert.ok(section.includes('| acme/tools/fmt | Format the code. |'), section);
  assert.ok(section.includes('| acme/lint | Lint the code. |'), section);
  assert.deepEqual(
    calls.acme?.filter(({ method }) => method === 'list'),
    [{ method: 'list', input: { cwd: '/workspace' }, scope }],
  );
});

void test('S2 loads a source skill with its heading, the origin line the source gives and its body without frontmatter, reading it by reference', async () => {
  const { load, calls } = world({ acme: acme() });

  assert.equal(
    await load('acme/tools/fmt'),
    [
      '# Skill: acme/tools/fmt',
      'From the acme tools (`fmt-ref`).',
      '# Fmt\n\nRun the formatter.',
    ].join('\n\n'),
  );
  assert.equal(
    await load('acme/lint'),
    '# Skill: acme/lint\n\n# Lint\n\nRun the linter.',
  );
  assert.deepEqual(
    calls.acme?.filter(({ method }) => method === 'read'),
    [
      { method: 'read', input: { reference: 'fmt-ref' }, scope },
      { method: 'read', input: { reference: 'lint-ref' }, scope },
    ],
  );
});

void test('S3 leaves out a source whose list answers after 5,000 ms, lists the others, and logs it once with its bundle id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { locators, warned } = world({
    slow: { list: () => after(6000, { skills: [sourceEntry('late')] }) },
    acme: listing('lint'),
  });

  const pending = locators();
  await settle();
  t.mock.timers.tick(5001);

  assert.deepEqual(await pending, ['acme/lint']);
  assert.deepEqual(warned(), ['slow']);
});

void test('S3 keeps a source whose list answers within 5,000 ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { locators, warned } = world({
    slow: { list: () => after(4900, { skills: [sourceEntry('late')] }) },
  });

  const pending = locators();
  await settle();
  t.mock.timers.tick(4900);

  assert.deepEqual(await pending, ['slow/late']);
  assert.deepEqual(warned(), []);
});

void test('S4 leaves out a source whose list rejects, lists the others, and logs it once with its bundle id', async () => {
  const { locators, warned } = world({
    broken: { list: () => Promise.reject(new Error('broken is down')) },
    acme: listing('lint'),
  });

  assert.deepEqual(await locators(), ['acme/lint']);
  assert.deepEqual(warned(), ['broken']);
});

void test('S5 leaves out the whole answer of a source that fails the contract schema, and logs each such source once', async () => {
  const { locators, warned } = world({
    unreferenced: {
      list: () => ({
        skills: [
          sourceEntry('kept'),
          { name: 'bare', description: 'No reference.' },
        ],
      }),
    },
    acme: listing('lint'),
    extra: {
      list: () => ({
        skills: [{ ...sourceEntry('fmt'), uri: 'skill://fmt/SKILL.md' }],
      }),
    },
    wrong: { list: () => ['not', 'an', 'answer'] },
  });

  assert.deepEqual(await locators(), ['acme/lint']);
  assert.deepEqual([...warned()].sort(), ['extra', 'unreferenced', 'wrong']);
});

void test('S6 logs a source that keeps failing once per prompt, however often the prompt reads its skills', async () => {
  const { locators, warned, prompt, services } = world({
    broken: { list: () => Promise.reject(new Error('broken is down')) },
  });
  const first = prompt();

  await locators(first);
  await locators(first);
  await readSourceSkills('/workspace', first, kernelPorts(services.services));

  assert.deepEqual(warned(), ['broken']);

  await locators(prompt(laterPromptId));

  assert.deepEqual(warned(), ['broken', 'broken']);
});

void test('S7 answers a source skill whose read takes longer than 5,000 ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { load } = world({
    acme: acme(() => after(6000, { text: 'Slow body.' })),
  });

  const pending = load('acme/lint');
  await settle();
  t.mock.timers.tick(6000);

  assert.equal(await pending, '# Skill: acme/lint\n\nSlow body.');
});

void test('S8 answers a source skill whose read rejects with the could-not-be-loaded failure naming it', async () => {
  const { load } = world({
    acme: acme(() => Promise.reject(new Error('acme lost the file'))),
  });

  await assert.rejects(load('acme/lint'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(
      error.message.startsWith('The skill acme/lint could not be loaded: '),
      error.message,
    );
    assert.ok(error.message.includes('acme lost the file'), error.message);
    return true;
  });
});

void test('S9 never asks a provider whose bundle id is cwd, the id of the working directory skills', async () => {
  const { locators, calls } = world({
    cwd: listing('impostor'),
    acme: listing('lint'),
  });

  assert.deepEqual(await locators(), ['acme/lint']);
  assert.deepEqual(calls.cwd, []);
});

void test('S10 lists the sources in provider order, each in its own order', async () => {
  const { locators } = world({
    zeta: { list: () => ({ skills: [sourceEntry('b'), sourceEntry('a')] }) },
    alpha: {
      list: () => ({
        skills: [sourceEntry('d', { group: 'g' }), sourceEntry('c')],
      }),
    },
  });

  assert.deepEqual(await locators(), [
    'zeta/b',
    'zeta/a',
    'alpha/g/d',
    'alpha/c',
  ]);
});
