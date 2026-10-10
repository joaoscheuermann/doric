import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';
import { providerKind, providerKinds } from 'llms';

import { type ErrorBody, serve } from './support/host.js';

/*
 * The configuration, credential, provider, tool, VM and terminal routes of
 * agents/doric's config-routes, credential-routes, vms and terminal suites,
 * run against the transport bundle over fake contract providers.
 */

const json = (body: unknown) => JSON.parse(JSON.stringify(body)) as unknown;

// Configuration -------------------------------------------------------------

const configuration = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: { token: '00000000-0000-4000-8000-000000000002' },
    },
  ],
  models: { execution: { providerId: 'openrouter', model: 'openai/gpt-5' } },
  execution: { maxTurns: 100 },
};
const snapshot = (revision: number) => ({
  configuration,
  revision,
  updatedAt: new Date(revision * 1000).toISOString(),
});

void test('returns the active configuration at the root config route', async (t) => {
  const host = await serve({
    configuration: { current: () => snapshot(1) },
  });
  t.after(host.close);
  const response = await host.request('/config');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot(1));
});

void test('hands the request body to host-config/v1 and answers the replacement', async (t) => {
  const received: unknown[] = [];
  const host = await serve({
    configuration: {
      replace: (body: unknown) => {
        received.push(body);
        return { status: 'replaced', config: snapshot(2) };
      },
    },
  });
  t.after(host.close);
  const response = await host.request('/config', 'PUT', configuration);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot(2));
  assert.deepEqual(received, [configuration]);
});

void test('answers an invalid configuration with the provider message', async (t) => {
  for (const message of [
    'The Doric configuration is invalid.',
    'Provider openrouter must reference an API_TOKEN credential, not a GIT one.',
  ]) {
    const host = await serve({
      configuration: { replace: () => ({ status: 'invalid', message }) },
    });
    t.after(host.close);
    const response = await host.request('/config', 'PUT', {
      providers: [],
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: { code: 'invalid_config', message },
    });
  }
});

void test('returns a stable error when configuration activation fails', async (t) => {
  for (const replace of [
    () => ({ status: 'rejected' }),
    () => {
      throw new Error('provider secret');
    },
  ]) {
    const host = await serve({ configuration: { replace } });
    t.after(host.close);
    const response = await host.request('/config', 'PUT', configuration);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {
      error: {
        code: 'configuration_rejected',
        message: 'The Doric configuration could not be activated.',
      },
    });
    assert.equal(body.includes('provider secret'), false);
  }
});

// Credentials ---------------------------------------------------------------

const id = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const secret = 'sk_private_value';
const described = {
  id,
  kind: 'API_TOKEN' as const,
  name: 'openrouter',
  hasSecret: true,
};

/** A `secrets/v1` refusal as the core provider raises it. */
const refusal = (code: string, message = 'Refused.') =>
  new ContractError(code, message);

void test('answers every credential without its secret', async (t) => {
  const host = await serve({ secrets: { list: () => [described] } });
  t.after(host.close);
  const response = await host.request('/credentials');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [described]);
});

void test('creates a credential and answers it without the secret', async (t) => {
  let received: unknown;
  const host = await serve({
    secrets: {
      create: (input: { name: string }) => {
        received = input;
        return { ...described, name: input.name };
      },
    },
  });
  t.after(host.close);
  const response = await host.request('/credentials', 'POST', {
    kind: 'API_TOKEN',
    name: '  openrouter  ',
    secret,
  });
  const body = await response.text();
  assert.equal(response.status, 201);
  assert.deepEqual(received, {
    kind: 'API_TOKEN',
    name: 'openrouter',
    secret,
  });
  assert.equal(body.includes(secret), false);
  assert.deepEqual(JSON.parse(body), described);
});

void test('rejects a create body that does not match its kind', async (t) => {
  let creates = 0;
  const host = await serve({
    secrets: {
      create: () => {
        creates += 1;
        return described;
      },
    },
  });
  t.after(host.close);
  for (const body of [
    { kind: 'API_TOKEN', name: 'openrouter' },
    { kind: 'GIT', name: 'github', username: 'octocat', secret },
    { kind: 'GIT', name: 'github', username: 'octocat', email: 'nope' },
    { kind: 'OTHER', name: 'openrouter', secret },
    { kind: 'API_TOKEN', name: 'key', secret: 'two\nlines' },
  ]) {
    const response = await host.request('/credentials', 'POST', body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.deepEqual(await response.json(), {
      error: {
        code: 'invalid_credential',
        message: 'The credential does not match its kind.',
      },
    });
  }
  assert.equal(creates, 0);
});

void test('updates a credential and reports the shared failures', async (t) => {
  const received: unknown[] = [];
  const host = await serve({
    secrets: {
      update: (
        ref: { id: string },
        input: { kind?: string; name?: string },
      ) => {
        received.push([ref, input]);
        if (input.kind !== undefined)
          throw refusal('credential_kind_immutable');
        if (input.name === 'taken') throw refusal('credential_name_taken');
        if (input.name === 'empty')
          throw refusal(
            'credential_invalid',
            'A GIT credential requires username, email and carries no other field.',
          );
        if (input.name === 'gone') throw refusal('credential_missing');
        return { ...described, name: input.name ?? described.name };
      },
    },
  });
  t.after(host.close);
  const updated = await host.request(`/credentials/${id}`, 'PATCH', {
    name: 'renamed',
    secret: null,
    username: '',
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { ...described, name: 'renamed' });
  assert.deepEqual(received[0], [
    { id },
    { name: 'renamed', secret: null, username: '' },
  ]);
  for (const [body, status, code, message] of [
    [
      { kind: 'GIT' },
      409,
      'credential_kind_immutable',
      'The credential cannot perform this operation.',
    ],
    [
      { name: 'taken' },
      409,
      'credential_name_taken',
      'The credential cannot perform this operation.',
    ],
    [
      { name: 'empty' },
      422,
      'invalid_credential',
      'A GIT credential requires username, email and carries no other field.',
    ],
    [
      { name: 'gone' },
      404,
      'credential_not_found',
      'The credential was not found.',
    ],
  ] as const) {
    const response = await host.request(`/credentials/${id}`, 'PATCH', body);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: { code, message } });
  }
  const invalid = await host.request('/credentials/not-an-id', 'PATCH', {
    name: 'x',
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: {
      code: 'invalid_credential_id',
      message: 'The credential ID is invalid.',
    },
  });
});

void test('refuses to delete a credential a provider or the configuration uses', async (t) => {
  const host = await serve({
    secrets: {
      delete: ({ id: target }: { id: string }) =>
        target === id
          ? 'referenced'
          : target.endsWith('1603')
            ? 'missing'
            : 'deleted',
    },
  });
  t.after(host.close);
  const referenced = await host.request(`/credentials/${id}`, 'DELETE');
  assert.equal(referenced.status, 409);
  assert.equal(
    ((await referenced.json()) as ErrorBody).error.code,
    'credential_referenced',
  );
  const deleted = await host.request(
    `/credentials/${id.replace('1601', '1602')}`,
    'DELETE',
  );
  assert.equal(deleted.status, 204);
  const missing = await host.request(
    `/credentials/${id.replace('1601', '1603')}`,
    'DELETE',
  );
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as ErrorBody).error.code,
    'credential_not_found',
  );
});

void test('answers an unusable host key as an unavailable store, and any other failure as internal', async (t) => {
  const host = await serve({
    secrets: {
      create: () => {
        throw refusal('credential_storage_unavailable');
      },
      update: () => {
        throw new Error(secret);
      },
    },
  });
  t.after(host.close);
  const response = await host.request('/credentials', 'POST', {
    kind: 'API_TOKEN',
    name: 'key',
    secret,
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'credential_storage_unavailable',
      message: 'The host cannot store credential secrets.',
    },
  });
  const failed = await host.request(`/credentials/${id}`, 'PATCH', {
    name: 'x',
  });
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes(secret), false);
});

// Providers -----------------------------------------------------------------

const models = (
  catalog: (input: unknown) => unknown = () => ({ status: 'absent' }),
) => ({
  kinds: () => providerKinds,
  kind: (kindId: string) => providerKind(kindId),
  catalog,
});

void test('answers the provider-kind catalog models/v1 lists', async (t) => {
  const host = await serve({ models: models() });
  t.after(host.close);
  const response = await host.request('/providers/kinds');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { kinds: { id: string }[] };
  assert.deepEqual(body.kinds, json(providerKinds));
  assert.deepEqual(
    body.kinds.map(({ id: kind }) => kind),
    ['openai', 'openrouter'],
  );
});

void test('answers the models a provider catalog describes', async (t) => {
  const received: unknown[] = [];
  const entry = {
    id: 'openai/gpt-5',
    name: 'OpenAI: GPT-5',
    parameters: ['tools', 'tool_choice'],
    reasonings: ['high', 'medium'],
    mandatory: false,
  };
  const host = await serve({
    models: models((input) => {
      received.push(input);
      return { status: 'read', models: [entry] };
    }),
  });
  t.after(host.close);
  const configuration = {
    modelsUrl: 'https://catalog.example.com/models',
    token: '00000000-0000-4000-8000-000000000002',
  };
  const response = await host.request('/providers/models', 'POST', {
    kind: '  openrouter ',
    configuration,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: [entry] });
  assert.deepEqual(received, [{ kind: 'openrouter', configuration }]);
});

void test('answers a catalog it cannot read, or that no URL names, as its own error', async (t) => {
  for (const status of ['failed', 'absent']) {
    const host = await serve({ models: models(() => ({ status })) });
    t.after(host.close);
    const response = await host.request('/providers/models', 'POST', {
      kind: 'openrouter',
      configuration: { token: '00000000-0000-4000-8000-000000000002' },
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'model_catalog_unreadable',
        message: 'The provider model catalog could not be read.',
      },
    });
  }
});

void test('refuses provider values the kind does not declare', async (t) => {
  let reads = 0;
  const host = await serve({
    models: models(() => {
      reads += 1;
      return { status: 'absent' };
    }),
  });
  t.after(host.close);
  for (const body of [
    { kind: 'lmstudio', configuration: { identityId: 'local' } },
    { kind: 'openrouter', configuration: { token: 'not-a-credential' } },
    { kind: 'openrouter', configuration: {} },
    { kind: 'openrouter', configuration: { token: '  ' } },
    {
      kind: 'openrouter',
      configuration: {
        token: '00000000-0000-4000-8000-000000000002',
        modelsUrl: 'ftp://catalog',
      },
    },
    {
      kind: 'openrouter',
      configuration: { token: '00000000-0000-4000-8000-000000000002' },
      models: [],
    },
    { kind: '', configuration: {} },
  ]) {
    const response = await host.request('/providers/models', 'POST', body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.deepEqual(await response.json(), {
      error: {
        code: 'invalid_provider',
        message: 'The provider values are invalid.',
      },
    });
  }
  assert.equal(reads, 0);
});

// Tools ---------------------------------------------------------------------

void test('lists each registered tool with its description and settings', async (t) => {
  const tool = (name: string, description?: string) => ({
    bundleId: 'files',
    alwaysAvailable: false,
    tool: {
      name,
      ...(description === undefined ? {} : { description }),
      settings: [{ key: 'root', label: 'Root' }],
      definition: {},
      input: {},
      output: {},
      execute: () => undefined,
    },
  });
  const host = await serve({
    tools: { list: () => [tool('read', 'Reads a file.'), tool('web')] },
  });
  t.after(host.close);
  const response = await host.request('/tools');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    tools: [
      {
        name: 'read',
        description: 'Reads a file.',
        settings: [{ key: 'root', label: 'Root' }],
      },
      { name: 'web', settings: [{ key: 'root', label: 'Root' }] },
    ],
  });
});

// VMs -----------------------------------------------------------------------

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const vms = [
  { id: 'vm-1', provider: 'firecracker' },
  { id: 'vm-2', provider: 'firecracker' },
];
const access = {
  host: '127.0.0.1',
  port: 2200,
  username: 'root' as const,
  privateKey: 'private-key',
  knownHosts: '[127.0.0.1]:2200 ssh-ed25519 host-key',
  hostKeyFingerprint: 'SHA256:test',
};
const serveVms = () =>
  serve({
    sandbox: {
      machines: () => vms,
      machine: (vmId: string) => vms.find((vm) => vm.id === vmId),
    },
    runtime: {
      vmSsh: (vmId: string) =>
        vmId === 'vm-1' ? { projectId, ssh: access } : undefined,
    },
  });

void test('returns every running VM', async (t) => {
  const host = await serveVms();
  t.after(host.close);
  const response = await host.request('/vms');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), vms);
});

void test('returns leased VM SSH access without permitting caches', async (t) => {
  const host = await serveVms();
  t.after(host.close);
  const response = await host.request('/vms/vm-1/ssh');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    vm: vms[0],
    projectId,
    ssh: access,
  });
});

void test('rejects SSH access for an idle VM', async (t) => {
  const host = await serveVms();
  t.after(host.close);
  const response = await host.request('/vms/vm-2/ssh');
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: {
      code: 'vm_ssh_unavailable',
      message: 'SSH is unavailable for this VM.',
    },
  });
});

void test('reports missing VMs through the stable error code', async (t) => {
  const host = await serveVms();
  t.after(host.close);
  const response = await host.request('/vms/missing/ssh');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: { code: 'vm_not_found', message: 'The VM was not found.' },
  });
});

// Terminals -----------------------------------------------------------------

const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
const terminal = {
  id: 'terminal-1',
  projectId,
  threadId,
  origin: 'user',
  command: 'bash',
  cwd: '/workspace',
  startedAt: '',
  timeoutMs: null,
  state: 'running',
  pty: true,
};

void test('creates, reads, writes, resizes and stops a terminal session', async (t) => {
  const received: unknown[] = [];
  const host = await serve({
    terminals: {
      list: (id: string) => (id === projectId ? [terminal] : []),
      create: (input: unknown) => {
        received.push(['create', input]);
        return terminal;
      },
      snapshot: (input: { id: string; after: number }) => {
        received.push(['snapshot', input]);
        return input.id === terminal.id
          ? { terminal, output: 'ok', offset: 2, truncated: false }
          : undefined;
      },
      input: (input: { id: string }) => {
        received.push(['input', input]);
        return input.id === terminal.id;
      },
      resize: (input: { id: string }) => {
        received.push(['resize', input]);
        return input.id === terminal.id;
      },
      stop: (id: string) => {
        received.push(['stop', id]);
        return false;
      },
    },
  });
  t.after(host.close);
  const listed = await host.request(`/projects/${projectId}/terminals`);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await listed.json(), { items: [terminal] });
  // The terminal router validates no id: an unknown one lists nothing.
  assert.deepEqual(
    await (await host.request('/projects/not-an-id/terminals')).json(),
    { items: [] },
  );
  const created = await host.request(`/threads/${threadId}/terminals`, 'POST', {
    cols: 80,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), terminal);
  const read = await host.request('/terminals/terminal-1?after=1');
  assert.deepEqual(await read.json(), {
    terminal,
    output: 'ok',
    offset: 2,
    truncated: false,
  });
  assert.equal(
    (
      await host.request('/terminals/terminal-1/input', 'POST', {
        data: 'ls\n',
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await host.request('/terminals/terminal-1/resize', 'POST', {
        cols: 100,
        rows: 40,
      })
    ).status,
    204,
  );
  // Stopping always answers 204, whatever the registry held.
  assert.equal(
    (await host.request('/terminals/terminal-1', 'DELETE')).status,
    204,
  );
  assert.deepEqual(received, [
    ['create', { threadId, cols: 80 }],
    ['snapshot', { id: 'terminal-1', after: 1 }],
    ['input', { id: 'terminal-1', data: 'ls\n' }],
    ['resize', { id: 'terminal-1', cols: 100, rows: 40 }],
    ['stop', 'terminal-1'],
  ]);
});

void test('reports missing terminals and invalid terminal input', async (t) => {
  const host = await serve({
    terminals: {
      create: () => undefined,
      snapshot: () => undefined,
      input: () => false,
      resize: () => false,
    },
  });
  t.after(host.close);
  for (const [path, method, body, status, code, message] of [
    [
      `/threads/${threadId}/terminals`,
      'POST',
      {},
      409,
      'terminal_unavailable',
      'The Thread has no active sandbox.',
    ],
    [
      `/threads/${threadId}/terminals`,
      'POST',
      { cols: 0 },
      422,
      'invalid_terminal',
      'Invalid terminal dimensions.',
    ],
    [
      '/terminals/gone',
      'GET',
      undefined,
      404,
      'terminal_missing',
      'Terminal no longer exists.',
    ],
    [
      '/terminals/gone?after=-1',
      'GET',
      undefined,
      422,
      'invalid_cursor',
      'Invalid output cursor.',
    ],
    [
      '/terminals/gone/input',
      'POST',
      { data: 'x' },
      404,
      'terminal_missing',
      'Terminal no longer exists.',
    ],
    [
      '/terminals/gone/input',
      'POST',
      { data: 'x', extra: 1 },
      422,
      'invalid_input',
      'Invalid terminal input.',
    ],
    [
      '/terminals/gone/resize',
      'POST',
      { cols: 1, rows: 1 },
      404,
      'terminal_missing',
      'Terminal no longer exists.',
    ],
    [
      '/terminals/gone/resize',
      'POST',
      { cols: 1001, rows: 1 },
      422,
      'invalid_size',
      'Invalid terminal dimensions.',
    ],
  ] as const) {
    const response = await host.request(path, method, body);
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: { code, message } });
  }
});
