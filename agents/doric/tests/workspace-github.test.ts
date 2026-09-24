import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../src/lib/config/schema.js';
import type { GithubIdentity } from '../src/lib/workspace/git.js';
import type { ThreadExecution } from '../src/lib/workspace/runtime.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import { deferred, fakeSandbox, pool, workspace } from './helpers/workspace.js';

interface Configured {
  readonly username: string;
  readonly email: string;
  readonly token: string;
}

/** One identity plus credential write: two `git config`, the helper, the store. */
const APPLY_COMMANDS = 4;

const identity = (overrides: Partial<Configured> = {}): Configured => ({
  username: 'doric-agent',
  email: 'agent@example.com',
  token: 'ghp_configured_token',
  ...overrides,
});

/**
 * A ready Project on a scripted sandbox whose GitHub block can be rotated the way
 * `PUT /config` rotates it. `open` leases the sandbox, `run` completes one turn so
 * a later rewind is not refused as busy.
 */
const host = (github?: GithubIdentity) => {
  const harness = workspace();
  const environment = fakeSandbox();
  const warnings: unknown[][] = [];
  /** Every value this generation was asked to redact after it was built. */
  const registered: string[] = [];
  const gates = new Map<string, { started: () => void; held: Promise<void> }>();
  let current = github;
  const generation = () => {
    const configured = current;
    return {
      snapshot: {
        configuration: {
          ...defaultConfig,
          ...(configured === undefined ? {} : { github: configured }),
        },
        revision: 1,
        updatedAt: new Date(0).toISOString(),
      },
      providers: new Map(),
      catalog: { skills: [], tools: [] },
      redactions: () => [
        ...(configured?.token === undefined ? [] : [configured.token]),
        ...registered,
      ],
      registerSecret: (value: string) => {
        registered.push(value);
      },
    };
  };
  const execute: ThreadExecution = async ({ job }) => {
    const gate = gates.get(job.prompt);
    gate?.started();
    await gate?.held;
    return 'done';
  };
  const service = createWorkspaceService({
    ...harness.dependencies,
    config: {
      current: generation,
      replace: () => {
        throw new Error('Configuration is not replaced in this test');
      },
    },
    pool: pool(undefined, environment),
    logger: {
      debug: () => undefined,
      error: () => undefined,
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    } as never,
    execute,
  });
  const open = async () => {
    const project = await service.projects.create('Project');
    await harness.projectState(project.id, 'ready');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread creation failed');
    return { project, thread: created.thread };
  };
  const run = async (threadId: string, prompt: string) => {
    const started = deferred();
    const held = deferred();
    gates.set(prompt, { started: started.resolve, held: held.promise });
    const accepted = await service.threads.prompt(threadId, prompt);
    if (accepted.status !== 'accepted')
      throw new Error(`Prompt was not accepted: ${accepted.status}`);
    await started.promise;
    held.resolve();
    await harness.threadState(threadId, 'ready');
    return accepted.promptId;
  };
  return {
    service,
    environment,
    warnings,
    registered,
    configure: (next?: GithubIdentity) => {
      current = next;
    },
    open,
    run,
  };
};

const commands = (
  environment: ReturnType<typeof fakeSandbox>,
): readonly string[] => environment.execs.map(({ cmd }) => cmd.join(' '));

/** The token may leave the host only in a sandbox process environment. */
const assertCredentialIsEnvOnly = (
  environment: ReturnType<typeof fakeSandbox>,
  token: string,
): void => {
  const entries = environment.execs.flatMap(({ env }) => env ?? []);
  assert.equal(
    entries.filter((entry) => entry.includes(token)).length,
    1,
    'the token must appear in exactly one environment entry',
  );
  assert.equal(
    commands(environment).some((cmd) => cmd.includes(token)),
    false,
    'no command line may carry the token',
  );
};

test('applies the configured identity and credential to a leased sandbox', async () => {
  const configured = identity();
  const hostUnderTest = host(configured);
  await hostUnderTest.open();

  const [name, email, helper, credential] = hostUnderTest.environment.execs;
  assert.deepEqual(name?.cmd, [
    'git',
    'config',
    '--global',
    'user.name',
    configured.username,
  ]);
  assert.deepEqual(email?.cmd, [
    'git',
    'config',
    '--global',
    'user.email',
    configured.email,
  ]);
  assert.deepEqual(helper?.cmd, [
    'git',
    'config',
    '--global',
    'credential.helper',
    'store',
  ]);
  assert.deepEqual(credential?.cmd.slice(0, 2), ['sh', '-c']);
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);

  // The script reads the variable the exec provides, creates the store 0600,
  // and never mentions the token.
  const [setting] = credential?.env ?? [];
  assert.equal(
    setting,
    `DORIC_GIT_CREDENTIAL=https://${configured.username}:${configured.token}@github.com`,
  );
  const variable = setting?.split('=')[0] ?? '';
  const script = credential?.cmd[2] ?? '';
  assert.ok(script.includes(`"$${variable}"`));
  assert.ok(script.includes('"$HOME/.git-credentials"'));
  assert.ok(script.includes('umask 077'));
  assert.ok(script.includes('printf'));
  assertCredentialIsEnvOnly(hostUnderTest.environment, configured.token);
});

test('issues no Git command when no GitHub block is configured', async () => {
  const hostUnderTest = host();
  const { thread } = await hostUnderTest.open();

  const accepted = await hostUnderTest.service.threads.prompt(
    thread.id,
    'hello',
  );
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(hostUnderTest.environment.execs, []);
});

test('re-applies a rotated block and never an unchanged one', async () => {
  const first = identity();
  const hostUnderTest = host(first);
  const { thread } = await hostUnderTest.open();
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  // The block the sandbox received is the one the Project captured, so nothing
  // has been registered for redaction yet.
  assert.deepEqual(hostUnderTest.registered, []);

  // The sandbox already holds this block, so a prompt issues nothing.
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'one')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  assert.deepEqual(hostUnderTest.registered, []);

  const rotated = identity({ token: 'ghp_rotated_token' });
  hostUnderTest.configure(rotated);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'two')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS * 2);
  // The Project's captured generation predates the rotation, so the token it
  // just received has to be registered for redaction before an event can carry
  // it: the sandbox's credential file is readable by the agent's own tools.
  assert.deepEqual(hostUnderTest.registered, ['ghp_rotated_token']);
  assert.deepEqual(hostUnderTest.environment.execs[4]?.cmd, [
    'git',
    'config',
    '--global',
    'user.name',
    rotated.username,
  ]);
  assert.equal(
    hostUnderTest.environment.execs[APPLY_COMMANDS * 2 - 1]?.env?.[0],
    `DORIC_GIT_CREDENTIAL=https://${rotated.username}:${rotated.token}@github.com`,
  );
  assertCredentialIsEnvOnly(hostUnderTest.environment, rotated.token);

  // The rotation is now the sandbox's block too, so nothing runs again.
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'three')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS * 2);

  // A removed block has nothing to apply; it cannot be unset remotely.
  hostUnderTest.configure(undefined);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'four')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS * 2);
});

test('applies a newly saved block to a Project that captured none', async () => {
  const hostUnderTest = host();
  const { thread } = await hostUnderTest.open();
  assert.deepEqual(hostUnderTest.environment.execs, []);

  const saved = identity();
  hostUnderTest.configure(saved);
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'hello')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  assertCredentialIsEnvOnly(hostUnderTest.environment, saved.token);
});

test('applies the current block before a rewound prompt is enqueued', async () => {
  const hostUnderTest = host();
  const { thread } = await hostUnderTest.open();
  const promptId = await hostUnderTest.run(thread.id, 'first');

  const saved = identity();
  hostUnderTest.configure(saved);
  const rewound = await hostUnderTest.service.threads.rewind(
    thread.id,
    promptId,
    'edited',
  );
  assert.equal(rewound.status, 'accepted');
  assert.equal(hostUnderTest.environment.execs.length, APPLY_COMMANDS);
  assertCredentialIsEnvOnly(hostUnderTest.environment, saved.token);
});

test('keeps a prompt usable when the credential write fails, logging no secret', async () => {
  const hostUnderTest = host(identity({ token: 'ghp_original_token' }));
  const { project, thread } = await hostUnderTest.open();

  // The rotated writes fail: one by rejecting, one by exiting non-zero. Neither
  // may break the prompt that needed the credential.
  const rejected = 'ghp_rejected_token';
  const exited = 'ghp_exiting_token';
  const exec = hostUnderTest.environment.exec;
  let writes = 0;
  hostUnderTest.environment.exec = async (input) => {
    if (input.cmd[0] !== 'sh') return exec(input);
    writes += 1;
    if (writes === 1) throw new Error(`Credential write failed: ${rejected}`);
    return { ...(await exec(input)), exitCode: 1 };
  };

  hostUnderTest.configure(identity({ token: rejected }));
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'hello')).status,
    'accepted',
  );
  hostUnderTest.configure(identity({ token: exited }));
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'again')).status,
    'accepted',
  );

  // Each warning names the Project and carries nothing else.
  assert.equal(hostUnderTest.warnings.length, 2);
  for (const warning of hostUnderTest.warnings) {
    assert.deepEqual(warning[0], { projectId: project.id });
    assert.equal(typeof warning[1], 'string');
  }
  const logged = JSON.stringify(hostUnderTest.warnings);
  assert.equal(logged.includes(rejected), false);
  assert.equal(logged.includes(exited), false);

  // The delivered block is the one the sandbox received, so no retry loop.
  assert.equal(
    (await hostUnderTest.service.threads.prompt(thread.id, 'third')).status,
    'accepted',
  );
  assert.equal(hostUnderTest.warnings.length, 2);
});
