import assert from 'node:assert/strict';
import test from 'node:test';

import { reusable } from '../src/lib/reuse.js';
import type {
  ContainerInspect,
  CreateContainerInput,
} from '../src/lib/types/docker.js';

const MiB = 1024 * 1024;

/** A create body with SSH published on 127.0.0.1 at a dynamic host port. */
const request = (
  hostConfig: Readonly<Record<string, unknown>> = {},
): CreateContainerInput => ({
  image: 'node:22-slim',
  workingDir: '/workspace',
  labels: {
    'doric.sandbox': 'true',
    'doric.sandbox.root': '/workspace',
    'doric.sandbox.workspace': 'project-a',
  },
  exposedPorts: ['22/tcp'],
  hostConfig: {
    AutoRemove: false,
    Binds: ['doric-workspace-project-a:/workspace'],
    NetworkMode: 'bridge',
    Memory: 512 * MiB,
    NanoCpus: 1_000_000_000,
    StorageOpt: { size: '4096M' },
    PortBindings: { '22/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    ...hostConfig,
  },
});

/** What Docker reports for a container created from `request()`. */
const reported = (
  config: Readonly<Record<string, unknown>> = {},
  host: Readonly<Record<string, unknown>> = {},
): ContainerInspect => ({
  id: 'container-1',
  ports: {},
  raw: {
    Config: {
      Image: 'node:22-slim',
      WorkingDir: '/workspace',
      Labels: {
        'doric.sandbox': 'true',
        'doric.sandbox.root': '/workspace',
        'doric.sandbox.workspace': 'project-a',
      },
      ExposedPorts: { '22/tcp': {} },
      ...config,
    },
    HostConfig: {
      NetworkMode: 'bridge',
      Memory: 512 * MiB,
      NanoCpus: 1_000_000_000,
      StorageOpt: { size: '4096M' },
      Binds: ['doric-workspace-project-a:/workspace'],
      PortBindings: { '22/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      Dns: null,
      ...host,
    },
  },
});

void test('reuses a container whose published SSH binding matches the request', () => {
  assert.equal(reusable(request(), reported()), true);
});

void test('reuses a container that reports no DNS servers when the request sets none', () => {
  assert.equal(
    reusable(request({ Dns: undefined }), reported({}, { Dns: null })),
    true,
  );
});

void test('does not reuse a container published on another SSH address', () => {
  assert.equal(
    reusable(
      request(),
      reported(
        {},
        {
          PortBindings: {
            '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '' }],
          },
        },
      ),
    ),
    false,
  );
});

void test('does not reuse a container with a fixed SSH port when the request leaves it dynamic', () => {
  assert.equal(
    reusable(
      request(),
      reported(
        {},
        {
          PortBindings: {
            '22/tcp': [{ HostIp: '127.0.0.1', HostPort: '2222' }],
          },
        },
      ),
    ),
    false,
  );
});

void test('does not reuse a container without SSH when the request enables it', () => {
  assert.equal(
    reusable(request(), reported({ ExposedPorts: null }, { PortBindings: {} })),
    false,
  );
});

void test('does not reuse a container that reports DNS servers the request does not name', () => {
  assert.equal(reusable(request(), reported({}, { Dns: ['1.1.1.1'] })), false);
});

void test('does not reuse a container whose metadata omits its labels', () => {
  const inspect = reported();
  const config = inspect.raw.Config as Record<string, unknown>;

  assert.equal(
    reusable(request(), {
      ...inspect,
      raw: { ...inspect.raw, Config: { ...config, Labels: undefined } },
    }),
    false,
  );
});

void test('does not reuse a container that binds a different Docker socket', () => {
  const shared = '/run/user/1000/docker.sock:/var/run/docker.sock';

  assert.equal(
    reusable(
      request({ Binds: ['doric-workspace-project-a:/workspace', shared] }),
      reported(),
    ),
    false,
  );

  assert.equal(
    reusable(
      request(),
      reported({}, { Binds: ['doric-workspace-project-a:/workspace', shared] }),
    ),
    false,
  );
});

void test('does not reuse a container whose metadata omits its memory limit', () => {
  assert.equal(reusable(request(), reported({}, { Memory: undefined })), false);
});
