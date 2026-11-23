// `skills/v1` served by `core` over the router (S40a): skills as data under
// D4's key rule (the skill name), with `allowedTools` checked against the
// tools the Register call sees through `tools/v1`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { type Client, ConnectError } from '@connectrpc/connect';
import { fromConnectError } from 'bundle/contracts';
import {
  type RegisteredSkill,
  SkillsService,
} from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';

import { type RoutedCore, serveCore } from '../support/router.js';

const rejectsWith = async (
  promise: Promise<unknown>,
  code: string,
  check?: (message: string) => void,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);

    const contract = fromConnectError(error);

    assert.equal(contract.code, code, error.message);
    check?.(contract.message);

    return true;
  });
};

const skills = (
  core: RoutedCore,
  bundleId: string,
  projectId?: string,
): Client<typeof SkillsService> =>
  core.client(
    SkillsService,
    bundleId,
    projectId === undefined ? {} : { scope: { projectId } },
  );

const registerTool = async (
  core: RoutedCore,
  bundleId: string,
  name: string,
  projectId?: string,
) => {
  await core.client(ToolsService, bundleId).register({
    tool: {
      name,
      definition: {
        name,
        inputSchema: '{"type":"object"}',
        outputSchema: '{"type":"object"}',
      },
    },
    options: {
      alwaysAvailable: false,
      ...(projectId === undefined ? {} : { projectId }),
    },
  });
};

interface SkillSpec {
  readonly description?: string;
  readonly allowedTools?: readonly string[];
  readonly order?: number;
}

const register = async (
  client: Client<typeof SkillsService>,
  name: string,
  spec: SkillSpec = {},
): Promise<string> => {
  const { registrationId } = await client.register({
    skill: {
      name,
      description: spec.description ?? `About ${name}.`,
      body: `Do ${name}.`,
      allowedTools: [...(spec.allowedTools ?? [])],
    },
    ...(spec.order === undefined ? {} : { options: { order: spec.order } }),
  });

  assert.notEqual(registrationId, '');

  return registrationId;
};

/** What a `List` entry tells, without the message bookkeeping. */
const shapeOf = (entry: RegisteredSkill) => ({
  bundleId: entry.bundleId,
  alwaysAvailable: entry.alwaysAvailable,
  order: entry.order,
  skill:
    entry.skill === undefined
      ? undefined
      : {
          name: entry.skill.name,
          description: entry.skill.description,
          body: entry.skill.body,
          allowedTools: [...entry.skill.allowedTools],
          indexText: entry.skill.indexText,
        },
});

const listed = async (core: RoutedCore) =>
  (await skills(core, 'runtime').list({})).skills.map(shapeOf);

const withCore = async (run: (core: RoutedCore) => Promise<void>) => {
  const core = await serveCore();

  try {
    await run(core);
  } finally {
    await core.close();
  }
};

void test('Register answers an id; List answers the decoded skills by order, then registration order', () =>
  withCore(async (core) => {
    await registerTool(core, 'mcp', 'search');

    const notes = skills(core, 'notes');

    await register(notes, 'triage', {
      description: 'Sort the inbox.',
      allowedTools: ['search', 'search'],
    });
    await register(notes, 'later');
    await register(skills(core, 'other'), 'first', { order: 1 });

    const list = await listed(core);

    assert.deepEqual(
      list.map(({ skill, bundleId }) => [skill?.name, bundleId]),
      [
        ['first', 'other'],
        ['triage', 'notes'],
        ['later', 'notes'],
      ],
    );
    assert.deepEqual(list[1], {
      bundleId: 'notes',
      alwaysAvailable: false,
      order: undefined,
      skill: {
        name: 'triage',
        description: 'Sort the inbox.',
        body: 'Do triage.',
        allowedTools: ['search'],
        indexText: 'triage | Sort the inbox. | search | Do triage.',
      },
    });
    assert.equal(list[0]?.order, 1);
  }));

void test('a name another bundle serves is duplicate_skill; the same instance replaces and keeps the id', () =>
  withCore(async (core) => {
    const notes = skills(core, 'notes');
    const first = await register(notes, 'triage', { description: 'Old.' });

    await rejectsWith(
      register(skills(core, 'other'), 'triage'),
      'duplicate_skill',
      (message) => {
        assert.equal(
          message,
          'Duplicate skill name "triage": bundle "notes" and bundle "other".',
        );
      },
    );

    const again = await register(notes, 'triage', { description: 'New.' });

    assert.equal(again, first);
    assert.deepEqual(
      (await listed(core)).map(({ skill, bundleId }) => [
        skill?.name,
        skill?.description,
        bundleId,
      ]),
      [['triage', 'New.', 'notes']],
    );
  }));

void test('an allowedTools entry the Register call does not see is unavailable_tool', () =>
  withCore(async (core) => {
    await registerTool(core, 'mcp', 'search', 'p1');

    await rejectsWith(
      register(skills(core, 'notes'), 'triage', { allowedTools: ['missing'] }),
      'unavailable_tool',
      (message) => {
        assert.equal(
          message,
          'Skill "triage" in bundle "notes" references unavailable tool "missing".',
        );
      },
    );
    // A tool of `p1` is not seen by an unscoped Register …
    await rejectsWith(
      register(skills(core, 'notes'), 'triage', { allowedTools: ['search'] }),
      'unavailable_tool',
    );
    // … nor by one scoped to another Project …
    await rejectsWith(
      register(skills(core, 'notes', 'p2'), 'triage', {
        allowedTools: ['search'],
      }),
      'unavailable_tool',
    );
    // … but is by one scoped to `p1`.
    await register(skills(core, 'notes', 'p1'), 'triage', {
      allowedTools: ['search'],
    });

    assert.deepEqual(
      (await listed(core)).map(({ skill }) => skill?.allowedTools),
      [['search']],
    );
  }));

void test('Unregister and InstanceGone drop skills', () =>
  withCore(async (core) => {
    const notes = skills(core, 'notes');
    const triage = await register(notes, 'triage');

    await register(notes, 'later');
    await register(skills(core, 'other'), 'kept');

    await notes.unregister({ registrationId: triage });

    assert.deepEqual(
      (await listed(core)).map(({ skill }) => skill?.name),
      ['later', 'kept'],
    );

    core.instanceGone({ bundleId: 'notes', generation: 1 });

    assert.deepEqual(
      (await listed(core)).map(({ skill }) => skill?.name),
      ['kept'],
    );
  }));
