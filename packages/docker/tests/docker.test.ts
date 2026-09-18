import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDockerClient,
  type DockerClient,
  DockerHttpError,
  DockerRequestAbortedError,
  DockerRequestTimeoutError,
  type DockerResponse,
  type DockerTransport,
  type DockerTransportRequest,
} from '../src/index.js';
import {
  configureDockerHost,
  firewallStrategy,
  preflightDockerHost,
  renderDockerFirewall,
} from '../src/lib/host.js';

const jsonResponse = (status: number, body: unknown): DockerResponse => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
});

const textResponse = (status: number, body: string): DockerResponse => ({
  status,
  headers: {},
  body: Buffer.from(body),
});

test('sends create container requests with Docker API paths and JSON body', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      return jsonResponse(201, { Id: 'container-1', Warnings: ['careful'] });
    },
  });

  const container = await client.createContainer({
    image: 'alpine:latest',
    name: 'workspace',
    cmd: ['sleep', '60'],
    env: ['A=B'],
    workingDir: '/workspace',
    labels: { owner: 'doric' },
    hostConfig: { NetworkMode: 'none' },
    networkDisabled: true,
  });

  assert.deepEqual(container, { id: 'container-1', warnings: ['careful'] });

  assert.equal(requests[0]?.method, 'POST');

  assert.equal(requests[0]?.path, '/containers/create');

  assert.deepEqual(requests[0]?.query, { name: 'workspace' });

  assert.deepEqual(requests[0]?.body, {
    Image: 'alpine:latest',
    Cmd: ['sleep', '60'],
    Env: ['A=B'],
    WorkingDir: '/workspace',
    Labels: { owner: 'doric' },
    HostConfig: { NetworkMode: 'none' },
    NetworkDisabled: true,
  });
});

test('maps Docker HTTP failures into structured errors', async () => {
  const client = createDockerClient({
    request: async () => textResponse(500, 'daemon failed'),
  });

  await assert.rejects(
    client.version(),
    (error: unknown) =>
      error instanceof DockerHttpError &&
      error.status === 500 &&
      error.method === 'GET' &&
      error.path === '/version' &&
      error.body === 'daemon failed',
  );
});

test('pulls images through the Docker image create endpoint', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      return textResponse(200, '{"status":"done"}\n');
    },
  });

  await client.pullImage({ image: 'node:slim' });

  assert.equal(requests[0]?.method, 'POST');

  assert.equal(requests[0]?.path, '/images/create');

  assert.deepEqual(requests[0]?.query, { fromImage: 'node:slim' });
});

test('honors timeout and abort controls around the injected transport', async () => {
  const never: DockerTransport = async () => new Promise(() => undefined);

  const timeoutClient = createDockerClient({
    request: never,
    timeoutMs: 1,
  });

  await assert.rejects(
    timeoutClient.ping(),
    (error: unknown) => error instanceof DockerRequestTimeoutError,
  );

  const abortClient = createDockerClient({ request: never });
  const controller = new AbortController();
  const pending = abortClient.ping({ signal: controller.signal });

  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof DockerRequestAbortedError,
  );
});

test(
  'uses DOCKER_HOST as the default Unix socket path when set',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const previous = process.env.DOCKER_HOST;
    const socketPath = `/tmp/doric-missing-${randomUUID()}.sock`;

    process.env.DOCKER_HOST = `unix://${socketPath}`;

    try {
      await assert.rejects(
        createDockerClient().ping(),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          'address' in error &&
          error.code === 'ENOENT' &&
          error.address === socketPath,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.DOCKER_HOST;
      } else {
        process.env.DOCKER_HOST = previous;
      }
    }
  },
);

test('creates starts and inspects execs while demuxing non TTY output', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      if (request.path === '/containers/container-1/exec') {
        return jsonResponse(201, { Id: 'exec-1' });
      }

      if (request.path === '/exec/exec-1/start') {
        return {
          status: 200,
          headers: {},
          body: Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]),
        };
      }

      return jsonResponse(200, { ExitCode: 7 });
    },
  });

  const result = await client.exec('container-1', {
    cmd: ['sh', '-lc', 'echo out'],
    workingDir: '/workspace',
    env: ['A=B'],
  });

  assert.deepEqual(
    requests.map((request) => [request.method, request.path]),
    [
      ['POST', '/containers/container-1/exec'],
      ['POST', '/exec/exec-1/start'],
      ['GET', '/exec/exec-1/json'],
    ],
  );

  assert.deepEqual(requests[0]?.body, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: ['sh', '-lc', 'echo out'],
    Env: ['A=B'],
    WorkingDir: '/workspace',
  });

  assert.equal(result.exitCode, 7);

  assert.equal(result.stdout, 'out\n');

  assert.equal(result.stderr, 'err\n');
});

test('uses Docker archive endpoints for upload and download', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      if (request.method === 'GET') {
        return textResponse(200, 'archive');
      }

      return textResponse(200, '');
    },
  });

  await client.putArchive('container-1', {
    path: '/workspace',
    archive: Buffer.from('tar'),
    copyUidGid: true,
  });

  const archive = await client.getArchive('container-1', {
    path: '/workspace/file.txt',
  });

  assert.equal(requests[0]?.method, 'PUT');

  assert.equal(requests[0]?.path, '/containers/container-1/archive');

  assert.deepEqual(requests[0]?.query, {
    path: '/workspace',
    noOverwriteDirNonDir: undefined,
    copyUIDGID: true,
  });

  assert.equal(Buffer.from(archive).toString('utf8'), 'archive');
});

test('provisions Sandbox runtimes with CPU memory and writable disk limits', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      if (request.path === '/containers/create') {
        return jsonResponse(201, { Id: 'sandbox-1' });
      }

      return {
        status: request.path === '/images/create' ? 200 : 204,
        headers: {},
        body: new Uint8Array(),
      };
    },
  });

  const runtime = await client.provision({
    image: 'node:22-slim',
    root: '/workspace',
    resources: { cpuCount: 2, memoryMiB: 768, diskMiB: 4096 },
    network: { mode: 'disabled', ssh: false },
  });

  await runtime.dispose();

  const create = requests.find(({ path }) => path === '/containers/create');

  assert.ok(create);

  const body = create.body as Record<string, unknown>;

  assert.deepEqual(body.HostConfig, {
    AutoRemove: false,
    Binds: [],
    NetworkMode: 'none',
    Memory: 805_306_368,
    NanoCpus: 2_000_000_000,
    StorageOpt: { size: '4096M' },
  });

  assert.equal(body.NetworkDisabled, true);

  assert.ok(
    requests.some(
      ({ method, path }) =>
        method === 'DELETE' && path === '/containers/sandbox-1',
    ),
  );
});

test('inspects containers and starts detached execs', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      if (request.path === '/containers/container-1/json') {
        return jsonResponse(200, {
          Id: 'container-1',
          NetworkSettings: {
            Networks: { bridge: { IPAddress: '172.17.0.2' } },
            Ports: {
              '22/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }],
            },
          },
        });
      }

      if (request.path === '/containers/container-1/exec') {
        return jsonResponse(201, { Id: 'exec-1' });
      }

      return textResponse(200, '');
    },
  });
  const inspect = await client.inspectContainer('container-1');

  assert.equal(inspect.ipAddress, '172.17.0.2');

  assert.deepEqual(inspect.ports['22/tcp'], [
    { hostIp: '127.0.0.1', hostPort: 49152 },
  ]);

  assert.equal(
    await client.execDetached('container-1', {
      cmd: ['/dropbearmulti', 'dropbear', '-F'],
      user: 'root',
    }),
    'exec-1',
  );

  assert.deepEqual(requests.at(-1)?.body, { Detach: true, Tty: false });
});

test('retries without a disk quota when Docker does not support one', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      if (request.path === '/containers/create') {
        return requests.filter(({ path }) => path === '/containers/create')
          .length === 1
          ? textResponse(500, 'storage-opt size is not supported')
          : jsonResponse(201, { Id: 'sandbox-1' });
      }

      return {
        status: request.path === '/images/create' ? 200 : 204,
        headers: {},
        body: new Uint8Array(),
      };
    },
  });

  const runtime = await client.provision({
    image: 'node:22-slim',
    root: '/workspace',
    resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
    network: { mode: 'disabled', ssh: false },
  });

  await runtime.dispose();

  const creates = requests.filter(({ path }) => path === '/containers/create');

  assert.equal(creates.length, 2);

  assert.deepEqual((creates[0]?.body as { HostConfig: unknown }).HostConfig, {
    AutoRemove: false,
    Binds: [],
    NetworkMode: 'none',
    Memory: 536_870_912,
    NanoCpus: 1_000_000_000,
    StorageOpt: { size: '4096M' },
  });

  assert.deepEqual((creates[1]?.body as { HostConfig: unknown }).HostConfig, {
    AutoRemove: false,
    Binds: [],
    NetworkMode: 'none',
    Memory: 536_870_912,
    NanoCpus: 1_000_000_000,
  });
});

test('renders host-input and protected-destination Docker rules', () => {
  const rules = renderDockerFirewall('doric_test', '172.17.0.2', {
    mode: 'egress',
    ssh: false,
    dnsServers: ['1.1.1.1'],
    allowPrivate: [{ cidr: '10.0.0.8/32', protocol: 'tcp', ports: [443] }],
  });

  assert.match(rules, /chain input/u);

  assert.match(rules, /ip saddr 172\.17\.0\.2 drop/u);

  assert.ok(
    rules.indexOf('ip daddr 10.0.0.0/8 drop') <
      rules.indexOf('ip daddr 1.1.1.1 udp dport 53 accept'),
  );

  assert.ok(
    rules.indexOf('ip daddr 10.0.0.8/32 tcp dport { 443 } accept') <
      rules.indexOf('ip daddr 10.0.0.0/8 drop'),
  );
});

test('selects nftables only on Linux and rejects unknown platforms', () => {
  assert.equal(firewallStrategy('linux'), 'nftables');

  assert.equal(firewallStrategy('darwin'), 'docker-desktop');

  assert.equal(firewallStrategy('win32'), 'docker-desktop');

  assert.throws(
    () => firewallStrategy('aix'),
    /Docker egress is unsupported on platform: aix/u,
  );
});

test('leaves Docker Desktop firewall and bridge networking unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doric-docker-host-'));

  const client = new Proxy({} as DockerClient, {
    get() {
      throw new Error('Docker Desktop firewall setup must not use the client');
    },
  });

  try {
    for (const platform of ['darwin', 'win32'] as const) {
      const config = {
        connection:
          platform === 'win32'
            ? ({ kind: 'namedPipe' } as const)
            : ({ kind: 'unix' } as const),
        dropbearPath: '/unused',
        statePath: directory,
        platform,
      };

      await preflightDockerHost(
        { mode: 'egress', ssh: false, dnsServers: ['1.1.1.1'] },
        config,
      );

      const host = await configureDockerHost({
        client,
        container: { id: `sandbox-${platform}`, warnings: [] },
        inspect: {
          id: `sandbox-${platform}`,
          ipAddress: '172.17.0.2',
          ports: {},
          raw: {},
        },
        network: {
          mode: 'egress',
          ssh: false,
          dnsServers: ['1.1.1.1'],
        },
        config,
      });

      await host.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects unknown platforms before provisioning', async () => {
  await assert.rejects(
    preflightDockerHost(
      { mode: 'disabled', ssh: false },
      {
        connection: { kind: 'unix' },
        dropbearPath: '/unused',
        statePath: '/unused',
        platform: 'aix',
      },
    ),
    /Docker egress is unsupported on platform: aix/u,
  );
});

const frame = (channel: number, text: string): Buffer => {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);

  header[0] = channel;

  header.writeUInt32BE(body.byteLength, 4);

  return Buffer.concat([header, body]);
};
