// The protovalidate-violation → today's-reason table (phase 3, S60c,
// contract s60 §2.7, D4, §3.9, tests M3, M4 and the unit half of M1/M2):
// `invalidApiInput` answers each method's violations with the route's id
// refusal or its body/query refusal, and keeps `invalid_input` for a method
// without an entry; every key of `apiViolations` names a method of the eight
// services, and every reason it holds is an `INVALID_ARGUMENT` row.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { DescMethod, DescService } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import {
  type ContractError,
  grpcCodeOf,
  isContractError,
} from 'bundle/contracts';
import type { InputViolation } from 'bundle/host';

import { ConfigService } from '../src/contracts/gen/doric/api/config/v1/config_pb.js';
import { CredentialsService } from '../src/contracts/gen/doric/api/credentials/v1/credentials_pb.js';
import { HostService } from '../src/contracts/gen/doric/api/host/v1/host_pb.js';
import { ProjectsService } from '../src/contracts/gen/doric/api/projects/v1/projects_pb.js';
import { ProvidersService } from '../src/contracts/gen/doric/api/providers/v1/providers_pb.js';
import { StatusService } from '../src/contracts/gen/doric/api/status/v1/status_pb.js';
import { TerminalsService } from '../src/contracts/gen/doric/api/terminals/v1/terminals_pb.js';
import { ThreadsService } from '../src/contracts/gen/doric/api/threads/v1/threads_pb.js';
import { apiViolations, invalidApiInput } from '../src/host/api/violations.js';

const services: readonly DescService[] = [
  ConfigService,
  CredentialsService,
  ProvidersService,
  HostService,
  ProjectsService,
  ThreadsService,
  TerminalsService,
  StatusService,
];

const methodOf = (service: DescService, name: string): DescMethod => {
  const method = service.methods.find((entry) => entry.name === name);

  assert.ok(method !== undefined, `${service.typeName}/${name}`);

  return method;
};

const keyOf = (method: DescMethod) =>
  `/${method.parent.typeName}/${method.name}`;

const violation = (
  field: readonly string[],
  message = 'value is invalid',
  ruleId = 'string.pattern',
): InputViolation => ({ field, ruleId, message });

/** The `ContractError` the hook answers, failing the test for anything else. */
const answer = (
  method: DescMethod,
  violations: readonly InputViolation[],
): ContractError => {
  const error = invalidApiInput(method, violations);

  assert.ok(isContractError(error), `${keyOf(method)}: a ContractError`);

  return error;
};

const projectIdRefusal = {
  reason: 'invalid_project_id',
  message: 'The project ID is invalid.',
};
const threadIdRefusal = {
  reason: 'invalid_thread_id',
  message: 'The thread ID is invalid.',
};
const credentialIdRefusal = {
  reason: 'invalid_credential_id',
  message: 'The credential ID is invalid.',
};

interface Row {
  readonly service: DescService;
  readonly method: string;
  /** The path field (proto name) and its refusal. */
  readonly path?: {
    readonly field: string;
    readonly reason: string;
    readonly message: string;
  };
  /** The body or query refusal; absent for "(none other)". */
  readonly other?: { readonly reason: string; readonly message: string };
}

const projectPath = { field: 'project_id', ...projectIdRefusal };
const threadPath = { field: 'thread_id', ...threadIdRefusal };
const credentialPath = { field: 'credential_id', ...credentialIdRefusal };

/** §3.9, every row with a fixed message (PutConfig is checked on its own), Watch left to S60d (Q6). */
const rows: readonly Row[] = [
  {
    service: CredentialsService,
    method: 'CreateCredential',
    other: {
      reason: 'invalid_credential',
      message: 'The credential does not match its kind.',
    },
  },
  {
    service: CredentialsService,
    method: 'UpdateCredential',
    path: credentialPath,
    other: {
      reason: 'invalid_credential',
      message: 'The credential does not match its kind.',
    },
  },
  {
    service: CredentialsService,
    method: 'DeleteCredential',
    path: credentialPath,
  },
  {
    service: ProvidersService,
    method: 'ListModels',
    other: {
      reason: 'invalid_provider',
      message: 'The provider values are invalid.',
    },
  },
  {
    service: ProjectsService,
    method: 'CreateProject',
    other: {
      reason: 'invalid_project',
      message: 'A Project name between 1 and 80 characters is required.',
    },
  },
  {
    service: ProjectsService,
    method: 'UpdateProject',
    path: projectPath,
    other: {
      reason: 'invalid_project',
      message: 'A Project name between 1 and 80 characters is required.',
    },
  },
  {
    service: ProjectsService,
    method: 'ListProjects',
    other: { reason: 'invalid_page', message: 'The page is invalid.' },
  },
  {
    service: ProjectsService,
    method: 'ListThreads',
    path: projectPath,
    other: { reason: 'invalid_page', message: 'The page is invalid.' },
  },
  {
    service: ProjectsService,
    method: 'SetProjectColor',
    path: projectPath,
    other: {
      reason: 'invalid_project_color',
      message: 'A Project color from the palette, or null, is required.',
    },
  },
  {
    service: ProjectsService,
    method: 'CreateThread',
    path: projectPath,
    other: {
      reason: 'invalid_thread',
      message:
        'A Thread name between 1 and 80 characters and optional parentThreadId are accepted.',
    },
  },
  ...[
    'ListFiles',
    'GetTree',
    'ReadFile',
    'GetDiff',
    'ListChanges',
    'GetFileDiff',
  ].map(
    (method): Row => ({
      service: ProjectsService,
      method,
      path: projectPath,
      other: {
        reason: 'invalid_project_path',
        message: 'The Project path is invalid.',
      },
    }),
  ),
  ...[
    'GetProject',
    'GetProjectSsh',
    'GetProjectResources',
    'TerminateProject',
    'DeleteProject',
  ].map(
    (method): Row => ({ service: ProjectsService, method, path: projectPath }),
  ),
  {
    service: ThreadsService,
    method: 'UpdateThread',
    path: threadPath,
    other: {
      reason: 'invalid_thread',
      message:
        'A Thread name, a working directory, an execution (providerId and model, with an optional effort), or a combination is required.',
    },
  },
  {
    service: ThreadsService,
    method: 'CreateBranch',
    path: threadPath,
    other: {
      reason: 'invalid_branch',
      message: 'An existing local branch name is required.',
    },
  },
  {
    service: ThreadsService,
    method: 'Prompt',
    path: threadPath,
    other: {
      reason: 'invalid_prompt',
      message: 'Only a non-empty prompt is accepted.',
    },
  },
  {
    service: ThreadsService,
    method: 'Steer',
    path: threadPath,
    other: {
      reason: 'invalid_steer',
      message: 'A non-empty prompt and the running promptId are required.',
    },
  },
  {
    service: ThreadsService,
    method: 'Resume',
    path: threadPath,
    other: { reason: 'invalid_resume', message: 'A promptId is required.' },
  },
  {
    service: ThreadsService,
    method: 'Interrupt',
    path: threadPath,
    other: { reason: 'invalid_interrupt', message: 'A promptId is required.' },
  },
  {
    service: ThreadsService,
    method: 'Rewind',
    path: threadPath,
    other: {
      reason: 'invalid_rewind',
      message: 'A prompt ID and a non-empty prompt are required.',
    },
  },
  {
    service: ThreadsService,
    method: 'ListEvents',
    path: threadPath,
    other: {
      reason: 'invalid_event_cursor',
      message: 'The event cursor is invalid.',
    },
  },
  ...['GetQueuedPrompt', 'DeleteQueuedPrompt'].map(
    (method): Row => ({
      service: ThreadsService,
      method,
      path: threadPath,
      other: { reason: 'invalid_prompt', message: 'A promptId is required.' },
    }),
  ),
  {
    service: ThreadsService,
    method: 'UpdateQueuedPrompt',
    path: threadPath,
    other: {
      reason: 'invalid_prompt',
      message: 'A prompt ID, non-empty text and its revision are required.',
    },
  },
  ...[
    'GetThread',
    'GetGit',
    'ListBranches',
    'Compact',
    'GetUsage',
    'GetQueue',
    'ResumeQueue',
    'TerminateThread',
    'DeleteThread',
  ].map(
    (method): Row => ({ service: ThreadsService, method, path: threadPath }),
  ),
  {
    service: ThreadsService,
    method: 'CreateTerminal',
    other: {
      reason: 'invalid_terminal',
      message: 'Invalid terminal dimensions.',
    },
  },
  {
    service: TerminalsService,
    method: 'GetTerminal',
    other: { reason: 'invalid_cursor', message: 'Invalid output cursor.' },
  },
  {
    service: TerminalsService,
    method: 'SendInput',
    other: { reason: 'invalid_input', message: 'Invalid terminal input.' },
  },
  {
    service: TerminalsService,
    method: 'Resize',
    other: { reason: 'invalid_size', message: 'Invalid terminal dimensions.' },
  },
];

void test("M1 (table): a violation of a method's path field answers the route's id refusal", () => {
  for (const row of rows) {
    if (row.path === undefined) continue;
    const method = methodOf(row.service, row.method);
    const error = answer(method, [
      violation([row.path.field], 'value must be a valid UUID', 'string.uuid'),
    ]);

    assert.equal(error.code, row.path.reason, keyOf(method));
    assert.equal(error.message, row.path.message, keyOf(method));
  }
});

void test("M1 (table): any other violation answers the route's body or query refusal with its sentence", () => {
  for (const row of rows) {
    if (row.other === undefined) continue;
    const method = methodOf(row.service, row.method);

    for (const violations of [
      [violation(['name'])],
      [violation([], 'a message rule failed', 'message.rule')],
      [violation(['prompt_id'], 'value must be a valid UUID', 'string.uuid')],
    ]) {
      const error = answer(method, violations);

      assert.equal(error.code, row.other.reason, keyOf(method));
      assert.equal(error.message, row.other.message, keyOf(method));
    }
  }
});

void test('M2 (table): a request breaking the path field and a body rule answers the path refusal, in either order', () => {
  for (const row of rows) {
    if (row.path === undefined || row.other === undefined) continue;
    const method = methodOf(row.service, row.method);
    const path = violation(
      [row.path.field],
      'value must be a valid UUID',
      'string.uuid',
    );
    const body = violation([], 'a message rule failed', 'message.rule');

    for (const violations of [
      [path, body],
      [body, path],
    ]) {
      const error = answer(method, violations);

      assert.equal(error.code, row.path.reason, keyOf(method));
      assert.equal(error.message, row.path.message, keyOf(method));
    }
  }
});

void test("M1 (table): PutConfig answers invalid_config with protovalidate's message of the first violation", () => {
  const method = methodOf(ConfigService, 'PutConfig');
  const error = answer(method, [
    violation(['configuration'], 'value is required', 'required'),
    violation(['other'], 'second message'),
  ]);

  assert.equal(error.code, 'invalid_config');
  assert.equal(error.message, 'value is required');
});

void test('a method without an entry keeps invalid_input (the hook answers undefined)', () => {
  for (const [service, name] of [
    [ConfigService, 'GetConfig'],
    [CredentialsService, 'ListCredentials'],
    [ProvidersService, 'ListKinds'],
    [HostService, 'ListTools'],
    [HostService, 'ListResources'],
    [HostService, 'ListVms'],
    [HostService, 'GetVmSsh'],
    [TerminalsService, 'DeleteTerminal'],
    [StatusService, 'Watch'],
    [ProjectsService, 'ListTerminals'],
  ] as const) {
    const method = methodOf(service, name);

    assert.equal(
      invalidApiInput(method, [violation(['x'])]),
      undefined,
      keyOf(method),
    );
  }
});

void test('M3: every key of apiViolations names a method of the eight services, and each row of §3.9 has its key', () => {
  const methods = new Set(
    services.flatMap((service) => service.methods.map(keyOf)),
  );
  const keys = Object.keys(apiViolations);

  for (const key of keys) assert.ok(methods.has(key), key);
  for (const row of [
    ...rows,
    { service: ConfigService, method: 'PutConfig' },
  ]) {
    const key = keyOf(methodOf(row.service, row.method));

    assert.ok(Object.hasOwn(apiViolations, key), key);
  }
});

void test("M3: each entry names its route's path field and refusal as §3.9 does", () => {
  for (const row of rows) {
    const key = keyOf(methodOf(row.service, row.method));
    const entry = apiViolations[key];

    assert.ok(entry !== undefined, key);
    assert.deepEqual(
      entry.path,
      row.path === undefined
        ? undefined
        : {
            field: row.path.field,
            refusal: { reason: row.path.reason, message: row.path.message },
          },
      key,
    );
    if (row.other !== undefined) {
      assert.deepEqual(entry.other, row.other, key);
    }
  }

  const putConfig = apiViolations[keyOf(methodOf(ConfigService, 'PutConfig'))];

  assert.equal(putConfig?.path, undefined);
  assert.equal(putConfig?.other.reason, 'invalid_config');
  assert.equal(putConfig?.other.message, undefined);
});

void test('M4: every reason in apiViolations has the INVALID_ARGUMENT row', () => {
  const entries = Object.values(apiViolations);

  assert.ok(entries.length > 0, 'the table is not empty');
  for (const entry of entries) {
    for (const reason of [entry.other.reason, entry.path?.refusal.reason]) {
      if (reason === undefined) continue;
      assert.equal(grpcCodeOf(reason), Code.InvalidArgument, reason);
    }
  }
});
