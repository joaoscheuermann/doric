import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type RestError,
  restContractError,
  restErrors,
} from 'runtime/contracts';

import { type Fakes, serve } from './support/host.js';

/*
 * R-ERR (stage 9 WP-H): the REST error each runtime contract outcome
 * answers, as `runtime/contracts` tabulates it for the desktop UI adapters,
 * compared with what the transport route really answers for that outcome.
 * Every case boots the routes over a fake runtime that answers one outcome.
 */

const id = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';

interface Case {
  /** The outcome under test, for the failure message. */
  readonly name: string;
  readonly fakes: Fakes;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  /** The table's answer for the same outcome. */
  readonly expected: RestError | undefined;
}

const answering = (value: unknown) => () => value;

const projectCases = (): Case[] => [
  ...(
    [
      ['GET', `/projects/${id}`, 'project'],
      ['PATCH', `/projects/${id}`, 'renameProject', { name: 'Name' }],
      ['PATCH', `/projects/${id}/color`, 'setProjectColor', { color: null }],
      ['POST', `/projects/${id}/terminate`, 'terminateProject'],
    ] as const
  ).map(([method, path, member, body]) => ({
    name: `runtime/v1.${member} undefined`,
    fakes: { runtime: { [member]: answering(undefined) } },
    method,
    path,
    body,
    expected: restErrors.project(undefined),
  })),
  ...(['missing', 'active'] as const).map((result) => ({
    name: `runtime/v1.deleteProject ${result}`,
    fakes: { runtime: { deleteProject: answering(result) } },
    method: 'DELETE',
    path: `/projects/${id}`,
    expected: restErrors.deleteProject(result),
  })),
];

const threadCases = (): Case[] => [
  ...(['missing', 'inactive', 'invalid_parent'] as const).map((status) => ({
    name: `createThread ${status}`,
    fakes: { threads: { createThread: answering({ status }) } },
    method: 'POST',
    path: `/projects/${id}/threads`,
    body: { name: 'Thread' },
    expected: restErrors.createThread({ status }),
  })),
  {
    name: 'threads undefined',
    fakes: { threads: { threads: answering(undefined) } },
    method: 'GET',
    path: `/projects/${id}/threads`,
    expected: restErrors.threads(undefined),
  },
  ...(
    [
      ['GET', `/threads/${id}`, 'thread'],
      ['PATCH', `/threads/${id}`, 'renameThread', { name: 'Name' }],
      ['POST', `/threads/${id}/terminate`, 'terminateThread'],
      ['GET', `/threads/${id}/queue`, 'queue'],
      ['GET', `/threads/${id}/usage`, 'usage'],
      ['GET', `/threads/${id}/events`, 'threadEvents'],
    ] as const
  ).map(([method, path, member, body]) => ({
    name: `${member} undefined`,
    fakes: { threads: { [member]: answering(undefined) } },
    method,
    path,
    body,
    expected: restErrors.thread(undefined),
  })),
  ...(
    [
      { status: 'missing' },
      { status: 'inactive' },
      { status: 'refused', change: { status: 'outside' } },
      { status: 'refused', change: { status: 'missing' } },
      { status: 'refused', change: { status: 'not-directory' } },
    ] as const
  ).map((result) => ({
    name: `setThreadCwd ${JSON.stringify(result)}`,
    fakes: { threads: { setThreadCwd: answering(result) } },
    method: 'PATCH',
    path: `/threads/${id}`,
    body: { cwd: '/workspace/x' },
    expected: restErrors.setThreadCwd(result),
  })),
  ...(['missing', 'active'] as const).map((result) => ({
    name: `deleteThread ${result}`,
    fakes: { threads: { deleteThread: answering(result) } },
    method: 'DELETE',
    path: `/threads/${id}`,
    expected: restErrors.deleteThread(result),
  })),
  ...(['missing', 'inactive'] as const).map((status) => ({
    name: `prompt ${status}`,
    fakes: { threads: { prompt: answering({ status }) } },
    method: 'POST',
    path: `/threads/${id}/prompt`,
    body: { prompt: 'Hello' },
    expected: restErrors.prompt({ status }),
  })),
  ...(
    ['missing', 'inactive', 'busy', 'unknown_prompt', 'storage_low'] as const
  ).map((status) => ({
    name: `resume ${status}`,
    fakes: { threads: { resume: answering({ status }) } },
    method: 'POST',
    path: `/threads/${id}/resume`,
    body: { promptId },
    expected: restErrors.resume({ status }),
  })),
  ...(['missing', 'inactive', 'busy', 'unknown_prompt'] as const).map(
    (status) => ({
      name: `rewind ${status}`,
      fakes: { threads: { rewind: answering({ status }) } },
      method: 'POST',
      path: `/threads/${id}/rewind`,
      body: { promptId, prompt: 'Again' },
      expected: restErrors.rewind({ status }),
    }),
  ),
  ...(['missing', 'inactive', 'not_running'] as const).map((result) => ({
    name: `pause ${result}`,
    fakes: { threads: { pause: answering(result) } },
    method: 'POST',
    path: `/threads/${id}/interrupt`,
    body: { promptId },
    expected: restErrors.pause(result),
  })),
  ...(
    ['missing', 'inactive', 'busy', 'unknown_prompt', 'storage_low'] as const
  ).map((status) => ({
    name: `resumeQueue ${status}`,
    fakes: { threads: { resumeQueue: answering({ status }) } },
    method: 'POST',
    path: `/threads/${id}/queue/resume`,
    expected: restErrors.resumeQueue({ status }),
  })),
  ...(['missing', 'inactive', 'busy', 'unknown_prompt'] as const).map(
    (result) => ({
      name: `removeQueued ${result}`,
      fakes: { threads: { removeQueued: answering(result) } },
      method: 'DELETE',
      path: `/threads/${id}/queue/${promptId}`,
      expected: restErrors.removeQueued(result),
    }),
  ),
  {
    name: 'queuedPrompt undefined',
    fakes: { threads: { queuedPrompt: answering(undefined) } },
    method: 'GET',
    path: `/threads/${id}/queue/${promptId}`,
    expected: restErrors.queuedPrompt(undefined),
  },
  ...(
    [
      'missing',
      'inactive',
      'unknown_prompt',
      'not_editable',
      'conflict',
      'invalid_prompt',
    ] as const
  ).map((status) => ({
    name: `editQueued ${status}`,
    fakes: { threads: { editQueued: answering({ status }) } },
    method: 'PATCH',
    path: `/threads/${id}/queue/${promptId}`,
    body: { text: 'Edited', revision: 1 },
    expected: restErrors.editQueued({ status }),
  })),
];

const leaseAndTerminalCases = (): Case[] => [
  ...(
    [
      { status: 'missing' },
      { status: 'inactive' },
      { status: 'pending' },
      { status: 'refused', message: 'The branch has uncommitted changes.' },
    ] as const
  ).map((result) => ({
    name: `branches (switch) ${JSON.stringify(result)}`,
    fakes: { lease: { branches: answering(result) } },
    method: 'POST',
    path: `/threads/${id}/branches`,
    body: { branch: 'main', cwd: '/workspace' },
    expected: restErrors.switchBranch(result),
  })),
  {
    name: 'terminals.create undefined',
    fakes: { terminals: { create: answering(undefined) } },
    method: 'POST',
    path: `/threads/${id}/terminals`,
    expected: restErrors.createTerminal(undefined),
  },
  {
    name: 'terminals.snapshot undefined',
    fakes: { terminals: { snapshot: answering(undefined) } },
    method: 'GET',
    path: '/terminals/terminal-1',
    expected: restErrors.terminalSnapshot(undefined),
  },
  {
    name: 'terminals.input false',
    fakes: { terminals: { input: answering(false) } },
    method: 'POST',
    path: '/terminals/terminal-1/input',
    body: { data: 'ls\n' },
    expected: restErrors.terminalWrite(false),
  },
  {
    name: 'terminals.resize false',
    fakes: { terminals: { resize: answering(false) } },
    method: 'POST',
    path: '/terminals/terminal-1/resize',
    body: { cols: 80, rows: 24 },
    expected: restErrors.terminalWrite(false),
  },
];

const check = async (cases: readonly Case[]) => {
  for (const entry of cases) {
    assert.ok(entry.expected !== undefined, `${entry.name} is an error`);
    const host = await serve(entry.fakes);
    try {
      const response = await host.request(entry.path, entry.method, entry.body);
      assert.deepEqual(
        { status: response.status, body: await response.json() },
        {
          status: entry.expected.status,
          body: {
            error: {
              code: entry.expected.code,
              message: entry.expected.message,
            },
          },
        },
        entry.name,
      );
    } finally {
      await host.close();
    }
  }
};

void test('the Project outcomes answer the table errors', async () => {
  await check(projectCases());
});

void test('the Thread and queue outcomes answer the table errors', async () => {
  await check(threadCases());
});

void test('the branch switch and terminal outcomes answer the table errors', async () => {
  await check(leaseAndTerminalCases());
});

void test('a success outcome is no error', () => {
  assert.equal(restErrors.deleteProject('deleted'), undefined);
  assert.equal(restErrors.prompt({ status: 'accepted', promptId }), undefined);
  assert.equal(restErrors.pause('interrupted'), undefined);
  assert.equal(restErrors.removeQueued('removed'), undefined);
  assert.equal(restErrors.terminalWrite(true), undefined);
  assert.equal(restErrors.thread({}), undefined);
});

void test('the adapter error keeps the code, the message and the status', () => {
  const error = restContractError(
    restErrors.deleteProject('active') as RestError,
  );
  assert.equal(error.name, 'ContractError');
  assert.equal(error.code, 'project_active');
  assert.equal(error.message, 'The project cannot perform this operation.');
  assert.deepEqual(error.details, { status: 409 });
});
