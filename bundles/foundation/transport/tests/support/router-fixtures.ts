// Shared fixtures of `transport`'s router tests (phase 3, S60c): the domain
// values of `host-routes.test.ts` (what the kernel's fakes answer, and what
// the router fakes answer once `encode`d into the generated messages), the
// Doric refusal of a failed call and its gRPC code, and small helpers.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  type DescMessage,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { type Code, ConnectError } from '@connectrpc/connect';
import {
  builtinCredentialKinds,
  type CredentialKindDefinition,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import { encode } from 'runtime/contracts';

import { type Harness, type HarnessOptions, harness } from './router.js';

/** The part on a test router, activated, stopped when the test ends. */
export const activated = async (
  t: TestContext,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.router.control.stop());
  await h.activate();

  return h;
};

/** How a call failed: the Doric reason and message, and the gRPC code. */
export interface Refusal {
  readonly reason: string;
  readonly message: string;
  readonly code: Code | undefined;
}

/** The refusal `promise` rejects with; fails the test when it resolves. */
export const refusalOf = async (
  promise: Promise<unknown>,
): Promise<Refusal> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectError) {
      const contract = fromConnectError(error);

      return {
        reason: contract.code,
        message: contract.message,
        code: error.code,
      };
    }

    assert.ok(isContractError(error), `expected a Doric error: ${error}`);

    return { reason: error.code, message: error.message, code: undefined };
  }

  return assert.fail('the call succeeded');
};

/** The first item of `stream`, `undefined` when it ends empty. */
export const first = async <T>(
  stream: AsyncIterable<T>,
): Promise<T | undefined> => {
  for await (const item of stream) return item;

  return undefined;
};

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asserts that `message` is the message of `schema` today's JSON `expected`
 * encodes to (both compared as proto JSON, so `null` and an absent optional
 * read the same).
 */
export const assertMessage = <D extends DescMessage>(
  schema: D,
  message: MessageShape<D>,
  expected: unknown,
  label?: string,
): void => {
  assert.deepEqual(
    toJson(schema, message),
    toJson(schema, encode(schema, expected)),
    label,
  );
};

/** `toJson` of a request, for the fakes' records. */
export const jsonOf = <D extends DescMessage>(
  schema: D,
  message: MessageShape<D>,
): JsonValue => toJson(schema, message);

// Configuration -------------------------------------------------------------

export const configuration = {
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

export const snapshot = (revision: number) => ({
  configuration,
  revision,
  updatedAt: new Date(revision * 1000).toISOString(),
});

// Credentials ---------------------------------------------------------------

export const credentialId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
export const secret = 'sk_private_value';
export const described = {
  id: credentialId,
  kind: 'API_TOKEN',
  name: 'openrouter',
  hasSecret: true,
};

/** The credential kinds the fake answers: the built-in ones, and the GIT kind git registers. */
export const registeredKinds: readonly CredentialKindDefinition[] = [
  ...builtinCredentialKinds,
  { id: 'GIT', required: ['username', 'email'], optional: [] },
];

// Providers -----------------------------------------------------------------

export const catalogEntry = {
  id: 'openai/gpt-5',
  name: 'OpenAI: GPT-5',
  parameters: ['tools', 'tool_choice'],
  reasonings: ['high', 'medium'],
  mandatory: false,
};

export const providerConfiguration = {
  modelsUrl: 'https://catalog.example.com/models',
  token: '00000000-0000-4000-8000-000000000002',
};

// Tools ---------------------------------------------------------------------

export const toolEntries = [
  {
    name: 'read',
    description: 'Reads a file.',
    settings: [{ key: 'root', label: 'Root' }],
  },
  { name: 'web', settings: [{ key: 'root', label: 'Root' }] },
];

// Resources -----------------------------------------------------------------

export const reading = {
  at: '2026-01-01T00:00:00.000Z',
  cpuCount: 8,
  loadAverage: 1.5,
  memoryTotalBytes: 4096,
  memoryUsedBytes: 2048,
  uptimeSeconds: 3600,
};

// VMs -----------------------------------------------------------------------

export const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
export const vms = [
  { id: 'vm-1', provider: 'firecracker' },
  { id: 'vm-2', provider: 'firecracker' },
];
export const access = {
  host: '127.0.0.1',
  port: 2200,
  username: 'root' as const,
  privateKey: 'private-key',
  knownHosts: '[127.0.0.1]:2200 ssh-ed25519 host-key',
  hostKeyFingerprint: 'SHA256:test',
};

// Terminals -----------------------------------------------------------------

export const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
export const terminal = {
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
export const terminalSnapshot = {
  terminal,
  output: 'ok',
  offset: 2,
  truncated: false,
};
