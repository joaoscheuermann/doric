// `git`'s host part through the router (phase 3, slice S55b, tests T1–T5):
// `activate` registers the `GIT` credential kind with `secrets/v1` (tracked,
// D7) and then the `git` tool with `tools/v1` (not always available,
// position 900), and `core`'s `ToolHandlerService` calls run the tool over
// `runtime.workspace/v1` and `runtime.lease/v1` under the relayed prompt
// scope. The tool's answers case by case are `git.test.ts`', which runs
// through the router too (`routedTool`).

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test, { type TestContext } from 'node:test';

import { fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type { Sandbox, SandboxExecInput, SandboxExecResult } from 'sandbox';

import { createTool } from '../src/host/tools/git.js';
import {
  type Harness,
  type HarnessOptions,
  harness,
  promptScope,
} from './support/router.js';

/** The environment every `git` run gets. */
const ENVIRONMENT = [
  'GIT_TERMINAL_PROMPT=0',
  'GIT_EDITOR=true',
  'GIT_SEQUENCE_EDITOR=true',
  'GCM_INTERACTIVE=Never',
];

/** A sandbox that records each `exec` and answers `result`. */
type RecordingSandbox = Sandbox & { readonly execs: SandboxExecInput[] };

const recordingSandbox = (result: SandboxExecResult): RecordingSandbox => {
  const execs: SandboxExecInput[] = [];
  const unsupported = (): never => {
    throw new Error('not used by the git tool');
  };

  return {
    id: 'git-test',
    root: '/workspace',
    execs,
    exec: async (input) => {
      execs.push(input);

      return result;
    },
    cloneRepo: unsupported,
    readFile: unsupported,
    writeFile: unsupported,
    putFile: unsupported,
    getFile: unsupported,
    diff: unsupported,
    ssh: async () => undefined,
  };
};

const resultOf = (
  stdout = '',
  exitCode: number | null = 0,
): SandboxExecResult => ({
  exitCode,
  stdout,
  stderr: '',
  stdoutBytes: Buffer.from(stdout),
  stderrBytes: Buffer.from(''),
});

/** The part activated on a test router, stopped when the test ends. */
const activated = async (
  t: TestContext,
  options: HarnessOptions,
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.router.control.stop());
  await h.activate();

  return h;
};

/** The Doric error `promise` rejects with; fails the test when it resolves. */
const rejectionOf = async (
  promise: Promise<unknown>,
): Promise<ContractError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectError) return fromConnectError(error);
    assert.ok(isContractError(error), `expected a Doric error: ${error}`);

    return error;
  }

  return assert.fail('the call succeeded');
};

/** `Execute{name: 'git', payload}`'s result as JSON. */
const execute = async (
  h: Harness,
  payload: JsonValue,
): Promise<JsonValue | undefined> => {
  const { result } = await h.client.execute({
    name: 'git',
    payload: fromJson(ValueSchema, payload),
  });

  return result === undefined ? undefined : toJson(ValueSchema, result);
};

/** The routed answer of `payload` over a sandbox answering `result`. */
const routedRun = async (
  t: TestContext,
  cwd: string,
  payload: JsonValue,
  result: SandboxExecResult,
) => {
  const routedSandbox = recordingSandbox(result);
  const h = await activated(t, { sandbox: routedSandbox, cwd });
  const routed = await execute(h, payload);

  return { h, routed, routedSandbox };
};

// T1.
void test('T1: activate sends RegisterKind GIT, then one Register of git, not always available, at 900, with the definition’s schemas', async (t) => {
  const h = await activated(t, { sandbox: recordingSandbox(resultOf()) });
  const tool = createTool();

  assert.deepEqual(
    h.calls.map(({ service, method }) => `${service}.${method}`),
    ['secrets.registerKind', 'tools.register'],
  );
  assert.deepEqual(h.calls[0]?.request, {
    credentialKindDefinition: {
      id: 'GIT',
      required: ['username', 'email'],
      optional: [],
      label: 'Git identity',
    },
  });

  const register = h.calls[1]?.request as {
    tool: {
      name: string;
      description: string;
      definition: { name: string; inputSchema: string; outputSchema: string };
    };
    options: { alwaysAvailable: boolean; order: number };
  };

  assert.equal(register.tool.name, 'git');
  assert.equal(register.tool.description, tool.description);
  assert.equal(register.tool.definition.name, tool.definition.name);
  assert.equal(
    register.tool.definition.inputSchema,
    JSON.stringify(tool.definition.inputSchema),
  );
  assert.equal(
    register.tool.definition.outputSchema,
    JSON.stringify(tool.definition.outputSchema),
  );
  assert.deepEqual(register.options, { alwaysAvailable: false, order: 900 });
});

// T2.
void test('T2: a RegisterKind refused duplicate_credential_kind rejects activate with it, and no Register is sent', async (t) => {
  const h = harness({
    sandbox: recordingSandbox(resultOf()),
    registerKindError: new ContractError(
      'duplicate_credential_kind',
      'GIT is already registered.',
    ),
  });

  t.after(() => h.router.control.stop());

  const error = await rejectionOf(h.activate());

  assert.equal(error.code, 'duplicate_credential_kind');
  assert.deepEqual(
    h.calls.map(({ service, method }) => `${service}.${method}`),
    ['secrets.registerKind'],
  );
});

// T3.
void test('T3: Execute sends Cwd{}, one Describe{target: {}} and one Exec{expectSandboxId} under the prompt scope, and answers the Git output', async (t) => {
  const payload = {
    args: ['branch', '--show-current'],
    working_directory: 'repo',
    timeout_ms: 5000,
  };
  const { h, routed, routedSandbox } = await routedRun(
    t,
    '/workspace',
    payload,
    resultOf('main\n'),
  );
  const toolCalls = h.calls.filter(
    ({ service }) => service === 'workspace' || service === 'lease',
  );

  assert.deepEqual(
    toolCalls.map(({ service, method, request }) => ({
      service,
      method,
      request,
    })),
    [
      { service: 'workspace', method: 'cwd', request: {} },
      { service: 'lease', method: 'describe', request: { target: {} } },
      {
        service: 'lease',
        method: 'exec',
        request: {
          target: { expectSandboxId: 'git-test' },
          request: {
            cmd: ['git', 'branch', '--show-current'],
            cwd: '/workspace/repo',
            env: ENVIRONMENT,
            timeoutMs: 5000,
          },
        },
      },
    ],
  );
  for (const call of toolCalls) {
    assert.deepEqual(call.scope, promptScope);
  }
  assert.deepEqual(routedSandbox.execs, [
    {
      cmd: ['git', 'branch', '--show-current'],
      cwd: '/workspace/repo',
      env: ENVIRONMENT,
      timeoutMs: 5000,
    },
  ]);
  const output = routed as {
    schema: string;
    success: boolean;
    exit_code: number;
    working_directory: string;
    stdout: { text: string };
  };
  assert.equal(output.schema, 'git.command.v1');
  assert.equal(output.success, true);
  assert.equal(output.exit_code, 0);
  assert.equal(output.working_directory, '/workspace/repo');
  assert.equal(output.stdout.text, 'main\n');
});

// T3 (the cases of `git.test.ts`, whose answers that suite states).
void test('T3: the default directory, the timeout cap, relative and absolute directories and bounded output each run one Exec', async (t) => {
  const stdout = `${'a'.repeat(20_000)}${'z'.repeat(20_000)}`;
  const cases: readonly (readonly [string, JsonValue, SandboxExecResult])[] = [
    [
      '/workspace/repo',
      { args: ['status', '--short'], timeout_ms: 999_999 },
      resultOf(),
    ],
    [
      '/workspace/repo',
      { args: ['status', '--short'], working_directory: 'src' },
      resultOf(' M a.txt\n'),
    ],
    [
      '/workspace/repo',
      { args: ['status'], working_directory: '/workspace/other' },
      resultOf('', 128),
    ],
    ['/workspace', { args: ['log', '--oneline', '--all'] }, resultOf(stdout)],
  ];

  for (const [cwd, payload, result] of cases) {
    const { routed, routedSandbox } = await routedRun(t, cwd, payload, result);

    assert.equal(routedSandbox.execs.length, 1, JSON.stringify(payload));
    assert.equal(
      (routed as { exit_code: number }).exit_code,
      result.exitCode,
      JSON.stringify(payload),
    );
  }
});

// T4.
void test('T4: a sandbox switched after Describe makes the output exit_code -1 with "Failed to execute Git in sandbox:", and the call succeeds', async (t) => {
  const sandbox = recordingSandbox(resultOf('main\n'));
  const h = await activated(t, { sandbox });

  h.state.switchAfterDescribe = 'other-sandbox';

  const output = (await execute(h, { args: ['status'] })) as {
    exit_code: number;
    success: boolean;
    stderr: { text: string };
  };

  assert.equal(output.exit_code, -1);
  assert.equal(output.success, false);
  assert.match(output.stderr.text, /^Failed to execute Git in sandbox:/u);
  assert.deepEqual(sandbox.execs, []);
});

// T5.
void test('T5: Cwd failing thread_control_inactive fails Execute with that code, before any lease call', async (t) => {
  const h = await activated(t, { sandbox: recordingSandbox(resultOf()) });

  h.state.cwdError = new ContractError(
    'thread_control_inactive',
    'The prompt has ended.',
  );

  const error = await rejectionOf(execute(h, { args: ['status'] }));

  assert.equal(error.code, 'thread_control_inactive');
  assert.deepEqual(
    h.calls.filter(({ service }) => service === 'lease'),
    [],
  );
});
