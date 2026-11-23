import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest } from 'llms';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';

import { SkillSourcesService } from '../src/contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';
import {
  type FakeLease,
  type FakeSkillSource,
  type HarnessSkill,
  skill,
  sourceEntry,
} from './support/harness.js';
import {
  type CatalogSource,
  type RecordedWrite,
  routed,
} from './support/router.js';
import {
  callsOf,
  kernelOf,
  kernelTool,
  scriptedModel,
  type Turn,
} from './support/router-helpers.js';
import { plain } from './support/router-wire.js';

// `default`'s host part through the router (phase 3, slice S51d, contract §6,
// D21-D23): a routed run lists `skills/v1`'s skills, scans the workspace
// through `runtime.lease/v1`, asks the active providers of
// `default.skill-sources/v1` the catalog names, and loads a skill as the
// kernel does.

const SKILLS_DIR = '/.agents/skills';
const SKILL_PATH = '/workspace/.agents/skills/local/SKILL.md';
const GUIDE_URI = 'skill://docs/guide/SKILL.md';
const GUIDE_REFERENCE = `server-1\n${GUIDE_URI}`;

/** One skill always available, one to load. */
const bundled: readonly HarnessSkill[] = [
  skill('always', 'Always body.'),
  skill('b', 'B body.', { alwaysAvailable: false }),
];

/** A sandbox whose working directory holds one skill, `local`; every other exec answers nothing. */
const workspaceLease = (): FakeLease => ({
  exec: (input) =>
    String(input.cmd.at(-1)).endsWith(SKILLS_DIR)
      ? {
          exitCode: 0,
          stdout:
            'local\0---\nname: local\ndescription: Local description.\n---\n\0',
          stderr: '',
        }
      : { exitCode: 0, stdout: '', stderr: '' },
  readFile: () =>
    '---\nname: local\ndescription: Local description.\n---\n\nFollow the local steps.\n',
});

/** The skill source of `mcp`: one connected server, "Docs", serving `guide`. */
const docsServer = (
  list: FakeSkillSource['list'] = () => ({
    skills: [
      sourceEntry('guide', {
        group: 'docs',
        description: 'Guide description.',
        reference: GUIDE_REFERENCE,
      }),
    ],
  }),
): FakeSkillSource => ({
  list,
  read: () => ({
    origin: `From the MCP server "Docs" (\`${GUIDE_URI}\`). Its other files are not available.`,
    text: '---\nname: guide\ndescription: Guide description.\n---\nFollow the guide.',
  }),
});

/** What each finished `load_skill` call answered, in order. */
const loaded = (writes: readonly RecordedWrite[]) =>
  writes
    .map(
      ({ event }) =>
        plain(event) as
          | { type?: string; call?: { name?: string }; result?: unknown }
          | undefined,
    )
    .filter(
      (event) =>
        event?.type === 'tool.finished' && event.call?.name === 'load_skill',
    )
    .map((event) => event?.result);

/** The kernel and the routed run of one scenario: `skills`, a lease, the `mcp` source, the model's `turns`. */
const runs = async (
  t: test.TestContext,
  options: {
    readonly lease?: FakeLease;
    readonly mcp?: FakeSkillSource;
    readonly turns: readonly Turn[];
  },
) => {
  const kernelModel = scriptedModel(options.turns);
  const kernel = kernelOf({
    provider: kernelModel.provider,
    skills: bundled,
    tools: [
      kernelTool('inspect', () => ({}), { description: 'Inspect state.' }),
    ],
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.mcp === undefined ? {} : { sources: { mcp: options.mcp } }),
  });
  await kernel.run('do the task');
  const model = scriptedModel(options.turns);
  const catalog: readonly CatalogSource[] =
    options.mcp === undefined ? [] : [{ bundleId: 'mcp', state: 'active' }];
  const host = routed({
    provider: model.provider,
    skills: bundled,
    tools: [{ name: 'inspect', description: 'Inspect state.' }],
    catalog,
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.mcp === undefined ? {} : { skillSource: options.mcp }),
  });
  t.after(() => host.router.control.stop());
  await host.activate();
  await host.run('do the task');

  return { kernel, kernelModel, host, model };
};

/** The system prompt of `request`. */
const systemOf = (request: ProviderRequest | undefined): unknown =>
  request?.messages[0]?.content;

void test('D21 a routed run lists the skills, scans the workspace with one exec of today’s script and sends the kernel’s # Skills section', async (t) => {
  const { kernel, kernelModel, host, model } = await runs(t, {
    lease: workspaceLease(),
    mcp: docsServer(),
    turns: [{ text: 'done' }],
  });

  assert.equal(systemOf(model.requests[0]), systemOf(kernelModel.requests[0]));
  assert.match(String(systemOf(model.requests[0])), /# Skills/);
  const scans = (cmds: readonly (readonly string[])[]) =>
    cmds.filter((cmd) => String(cmd.at(-1)).endsWith(SKILLS_DIR));
  const routedExecs = callsOf(host.calls, LeaseService, 'exec').map(
    ({ request }) => (request as { cmd: string[] }).cmd,
  );
  const kernelExecs = kernel.services.calls.lease
    .filter(({ method }) => method === 'exec')
    .map(({ input }) => (input as { cmd: string[] }).cmd);
  assert.equal(scans(routedExecs).length, 1);
  assert.deepEqual(scans(routedExecs), scans(kernelExecs));
});

/** A run over a catalog naming `providers` for `default.skill-sources/v1`, with one source fake. */
const sourcesRun = async (
  t: test.TestContext,
  catalog: readonly CatalogSource[] | 'fail',
  source: FakeSkillSource,
) => {
  const host = routed({
    provider: scriptedModel([{ text: 'done' }]).provider,
    skills: bundled,
    catalog,
    skillSource: source,
  });
  t.after(() => host.router.control.stop());
  await host.activate();
  const text = await host.run('do the task');
  return { host, text };
};

void test('D22 only an active provider other than cwd is asked for its skills, with the prompt’s working directory', async (t) => {
  const { host } = await sourcesRun(
    t,
    [
      { bundleId: 'mcp', state: 'active' },
      { bundleId: 'cwd', state: 'active' },
      { bundleId: 'old', state: 'quarantined' },
    ],
    docsServer(),
  );

  assert.deepEqual(
    callsOf(host.calls, SkillSourcesService, 'list').map(
      ({ request }) => request,
    ),
    [{ cwd: '/workspace' }],
  );
});

void test('D22 a source whose List fails is left out with one warning for the run', async (t) => {
  const { host, text } = await sourcesRun(
    t,
    [{ bundleId: 'mcp', state: 'active' }],
    docsServer(() => {
      throw new Error('server gone');
    }),
  );

  assert.equal(text, 'done');
  assert.equal(
    host.router.logs.filter(
      ({ level, message }) =>
        level === 'warn' && message === 'Skill source left out',
    ).length,
    1,
  );
});

void test('D22 a failed catalog Get leaves every source out and the run goes on', async (t) => {
  const { host, text } = await sourcesRun(t, 'fail', docsServer());

  assert.equal(text, 'done');
  assert.deepEqual(callsOf(host.calls, SkillSourcesService), []);
});

const loading = (name: string): Turn => ({
  calls: [{ name: 'load_skill', arguments: JSON.stringify({ name }) }],
});

void test('D23 load_skill of a source skill reads it with SkillSourcesService.Read and answers as the kernel tool', async (t) => {
  const { kernel, host } = await runs(t, {
    mcp: docsServer(),
    turns: [loading('mcp/docs/guide'), { text: 'done' }],
  });

  assert.deepEqual(
    callsOf(host.calls, SkillSourcesService, 'read').map(
      ({ request }) => request,
    ),
    [{ reference: GUIDE_REFERENCE }],
  );
  const answered = loaded(host.session.records);
  assert.equal(answered.length, 1);
  assert.deepEqual(answered, loaded(kernel.state.writes));
});

void test('D23 load_skill of a workspace skill reads it with LeaseService.ReadFile and answers as the kernel tool', async (t) => {
  const { kernel, host } = await runs(t, {
    lease: workspaceLease(),
    turns: [loading('cwd/local'), { text: 'done' }],
  });

  assert.deepEqual(
    callsOf(host.calls, LeaseService, 'readFile').map(({ request }) => request),
    [{ path: SKILL_PATH }],
  );
  const answered = loaded(host.session.records);
  assert.equal(answered.length, 1);
  assert.deepEqual(answered, loaded(kernel.state.writes));
});
