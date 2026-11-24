// C1 (phase 3, S59 D5): the codec of `mcp`'s host part. A `McpServerInput`
// message reads as today's domain input, re-parsed with today's zod schema
// (names and client names trimmed, an empty `scopes` and absent optionals
// left out; a refusal is `invalid_input` "Invalid input for mcp/v1
// <Method>." with its issues); a view becomes the wire's `McpServerView`,
// absent optionals staying absent; a skill source entry keeps its absent
// `group` absent.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { create, type MessageInitShape, toJson } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import { SkillSourceEntrySchema } from 'default/contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';

import {
  McpServerInputSchema,
  McpServerViewSchema,
} from '../src/contracts/gen/doric/mcp/v1/mcp_pb.js';
import type { McpServerInput, McpServerView } from '../src/contracts/index.js';
import {
  serverInputOf,
  serverViewMessageOf,
  skillSourceEntryMessageOf,
} from '../src/host/codec.js';

type InputInit = MessageInitShape<typeof McpServerInputSchema>;

const inputOf = (init: InputInit, method: 'Create' | 'Update' = 'Create') =>
  serverInputOf(create(McpServerInputSchema, init), method);

const refusal = (method: string) => (error: unknown) => {
  assert.ok(error instanceof ContractError, String(error));
  assert.equal(error.code, 'invalid_input');
  assert.equal(error.message, `Invalid input for mcp/v1 ${method}.`);
  const { issues } = error.details as { issues?: unknown };
  assert.ok(Array.isArray(issues) && issues.length > 0, 'its zod issues');
  return true;
};

/** The view's message as JSON, fields at their default left out. */
const viewJson = (view: McpServerView) =>
  toJson(
    McpServerViewSchema,
    create(McpServerViewSchema, serverViewMessageOf(view)),
  );

/** The view's editable part, read back through the request codec. */
const readBack = (view: McpServerView): McpServerInput => {
  const message = create(McpServerViewSchema, serverViewMessageOf(view));

  return serverInputOf(
    create(McpServerInputSchema, {
      name: message.name,
      enabled: message.enabled,
      ...(message.transport === undefined
        ? {}
        : { transport: message.transport }),
    }),
    'Update',
  );
};

const httpView: McpServerView = {
  id: 'server-1',
  projectId: 'project-1',
  name: 'Docs',
  enabled: true,
  transport: {
    kind: 'http',
    url: 'https://docs.example/mcp',
    headers: [
      { name: 'X-Api-Key', value: 'literal' },
      { name: 'X-Empty', value: '' },
      { name: 'Authorization', credentialId: 'credential-1' },
    ],
    clientName: 'Doric Test',
    scopes: ['read', 'write'],
    clientInfo: { name: 'doric', version: '2.0.0' },
  },
  status: { state: 'connected' },
  signedIn: true,
  tools: [
    { name: 'get_weather', title: 'Weather', description: 'Today.' },
    { name: 'bare' },
  ],
  skills: [{ uri: 'skill://docs/a', name: 'a', description: 'The A skill.' }],
};

const stdioView: McpServerView = {
  id: 'server-2',
  projectId: 'project-1',
  name: 'Local',
  enabled: false,
  transport: {
    kind: 'stdio',
    command: 'node',
    args: ['server.js', '--stdio'],
    env: [
      { name: 'MODE', value: 'test' },
      { name: 'TOKEN', credentialId: 'credential-2' },
    ],
  },
  status: { state: 'error', message: 'The MCP server closed the connection.' },
  signedIn: false,
  tools: [],
  skills: [],
};

describe('C1: serverViewMessageOf', () => {
  test('an http view: both entry kinds, scopes, clientName and clientInfo; status without message; tool optionals absent stay absent', () => {
    assert.deepEqual(viewJson(httpView), {
      name: 'Docs',
      enabled: true,
      transport: {
        http: {
          url: 'https://docs.example/mcp',
          headers: [
            { name: 'X-Api-Key', value: 'literal' },
            { name: 'X-Empty', value: '' },
            { name: 'Authorization', credentialId: 'credential-1' },
          ],
          clientName: 'Doric Test',
          scopes: ['read', 'write'],
          clientInfo: { name: 'doric', version: '2.0.0' },
        },
      },
      id: 'server-1',
      projectId: 'project-1',
      status: { state: 'connected' },
      signedIn: true,
      tools: [
        { name: 'get_weather', title: 'Weather', description: 'Today.' },
        { name: 'bare' },
      ],
      skills: [
        { uri: 'skill://docs/a', name: 'a', description: 'The A skill.' },
      ],
    });
  });

  test('a stdio view: absent cwd and clientInfo stay absent; status message present', () => {
    assert.deepEqual(viewJson(stdioView), {
      name: 'Local',
      transport: {
        stdio: {
          command: 'node',
          args: ['server.js', '--stdio'],
          env: [
            { name: 'MODE', value: 'test' },
            { name: 'TOKEN', credentialId: 'credential-2' },
          ],
        },
      },
      id: 'server-2',
      projectId: 'project-1',
      status: {
        state: 'error',
        message: 'The MCP server closed the connection.',
      },
    });
  });

  test('absent scopes, clientName and clientInfo version stay absent on the wire', () => {
    const view: McpServerView = {
      ...httpView,
      transport: {
        kind: 'http',
        url: 'https://docs.example/mcp',
        headers: [],
        clientInfo: { name: 'doric' },
      },
    };
    const message = create(McpServerViewSchema, serverViewMessageOf(view));

    assert.equal(message.transport?.kind.case, 'http');
    const http =
      message.transport?.kind.case === 'http'
        ? message.transport.kind.value
        : undefined;
    assert.deepEqual(http?.scopes, []);
    assert.equal(http?.clientName, undefined);
    assert.equal(http?.clientInfo?.name, 'doric');
    assert.equal(http?.clientInfo?.version, undefined);
  });
});

describe('C1: serverInputOf', () => {
  test('round trip: a view read back through the request codec is its input, for both transports', () => {
    for (const view of [httpView, stdioView]) {
      const { name, enabled, transport } = view;
      assert.deepEqual(readBack(view), { name, enabled, transport });
    }
  });

  test('an empty scopes list reads as absent; a non-empty one is kept', () => {
    const base: InputInit = {
      name: 'Docs',
      enabled: true,
      transport: {
        kind: {
          case: 'http',
          value: { url: 'https://docs.example/mcp', headers: [], scopes: [] },
        },
      },
    };
    const withoutScopes = inputOf(base);

    assert.deepEqual(withoutScopes, {
      name: 'Docs',
      enabled: true,
      transport: { kind: 'http', url: 'https://docs.example/mcp', headers: [] },
    });
    assert.ok(!('scopes' in withoutScopes.transport));

    const withScopes = inputOf({
      ...base,
      transport: {
        kind: {
          case: 'http',
          value: {
            url: 'https://docs.example/mcp',
            headers: [],
            scopes: ['openid'],
          },
        },
      },
    });

    assert.deepEqual(withScopes.transport, {
      kind: 'http',
      url: 'https://docs.example/mcp',
      headers: [],
      scopes: ['openid'],
    });
  });

  test('absent clientInfo fields and an absent cwd stay absent; the keys are not there', () => {
    const input = inputOf({
      name: 'Local',
      enabled: true,
      transport: {
        kind: {
          case: 'stdio',
          value: {
            command: 'node',
            args: [],
            env: [],
            clientInfo: { name: 'doric' },
          },
        },
      },
    });

    assert.deepEqual(input.transport, {
      kind: 'stdio',
      command: 'node',
      args: [],
      env: [],
      clientInfo: { name: 'doric' },
    });
    assert.ok(input.transport.kind === 'stdio');
    assert.ok(!('cwd' in input.transport));
    assert.ok(
      input.transport.clientInfo !== undefined &&
        !('version' in input.transport.clientInfo),
    );
  });

  test('names, client names and clientInfo are trimmed as today', () => {
    const input = inputOf({
      name: '  Docs  ',
      enabled: true,
      transport: {
        kind: {
          case: 'http',
          value: {
            url: 'https://docs.example/mcp',
            headers: [
              { name: 'X-Key', source: { case: 'value', value: ' v ' } },
            ],
            clientName: '  Doric  ',
            clientInfo: { name: ' doric ', version: ' 1.2.3 ' },
          },
        },
      },
    });

    assert.deepEqual(input, {
      name: 'Docs',
      enabled: true,
      transport: {
        kind: 'http',
        url: 'https://docs.example/mcp',
        headers: [{ name: 'X-Key', value: ' v ' }],
        clientName: 'Doric',
        clientInfo: { name: 'doric', version: '1.2.3' },
      },
    });
  });

  test('an over-long name is refused invalid_input "Invalid input for mcp/v1 Create." with its issues', () => {
    assert.throws(
      () =>
        inputOf({
          name: 'x'.repeat(65),
          enabled: true,
          transport: {
            kind: {
              case: 'stdio',
              value: { command: 'node', args: [], env: [] },
            },
          },
        }),
      refusal('Create'),
    );
  });

  test('a refusal names the method: Update', () => {
    assert.throws(
      () =>
        inputOf(
          {
            name: 'x'.repeat(65),
            enabled: true,
            transport: {
              kind: {
                case: 'stdio',
                value: { command: 'node', args: [], env: [] },
              },
            },
          },
          'Update',
        ),
      refusal('Update'),
    );
  });

  test('an absent message or transport is refused invalid_input', () => {
    assert.throws(() => serverInputOf(undefined, 'Create'), refusal('Create'));
    assert.throws(
      () => inputOf({ name: 'Docs', enabled: true }),
      refusal('Create'),
    );
  });
});

describe('C1: skillSourceEntryMessageOf', () => {
  test('a grouped entry keeps every field; an absent group stays absent', () => {
    const json = (entry: Parameters<typeof skillSourceEntryMessageOf>[0]) =>
      toJson(
        SkillSourceEntrySchema,
        create(SkillSourceEntrySchema, skillSourceEntryMessageOf(entry)),
      );

    assert.deepEqual(
      json({
        group: 'docs',
        name: 'a',
        description: 'The A skill.',
        reference: 'mcp:server-1:skill://docs/a',
      }),
      {
        group: 'docs',
        name: 'a',
        description: 'The A skill.',
        reference: 'mcp:server-1:skill://docs/a',
      },
    );

    const ungrouped = create(
      SkillSourceEntrySchema,
      skillSourceEntryMessageOf({
        name: 'b',
        description: 'The B skill.',
        reference: 'ref-b',
      }),
    );

    assert.equal(ungrouped.group, undefined);
    assert.deepEqual(toJson(SkillSourceEntrySchema, ungrouped), {
      name: 'b',
      description: 'The B skill.',
      reference: 'ref-b',
    });
  });
});
