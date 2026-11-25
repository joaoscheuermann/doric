// The window's side of the `mcp/v1` wire (slice S65c): a server input as the
// generated `McpServerInput`, and a generated `McpServerView` read back as
// today's view, checked against `mcpServerViewSchema`.

import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  ContractError,
  type CredentialDescription,
  credentialDescriptionSchema,
} from 'bundle/contracts';
import type { CredentialDescription as CredentialDescriptionMessage } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';

import type {
  McpClientInfo as McpClientInfoMessage,
  McpClientInfoSchema,
  McpEntry as McpEntryMessage,
  McpEntrySchema,
  McpServerInputSchema,
  McpServerView as McpServerViewMessage,
  McpTransport as McpTransportMessage,
  McpTransportSchema,
} from '../contracts/gen/doric/mcp/v1/mcp_pb.js';
import {
  type McpClientInfo,
  type McpEntry,
  type McpServerInput,
  type McpServerView,
  type McpTransport,
  mcpServerViewSchema,
} from '../contracts/index.js';

const entryMessageOf = (
  entry: McpEntry,
): MessageInitShape<typeof McpEntrySchema> =>
  'credentialId' in entry
    ? {
        name: entry.name,
        source: { case: 'credentialId', value: entry.credentialId },
      }
    : { name: entry.name, source: { case: 'value', value: entry.value } };

const clientInfoMessageOf = (
  info: McpClientInfo | undefined,
): MessageInitShape<typeof McpClientInfoSchema> | undefined =>
  info === undefined ? undefined : { name: info.name, version: info.version };

const transportMessageOf = (
  transport: McpTransport,
): MessageInitShape<typeof McpTransportSchema> =>
  transport.kind === 'http'
    ? {
        kind: {
          case: 'http',
          value: {
            url: transport.url,
            headers: transport.headers.map(entryMessageOf),
            clientName: transport.clientName,
            scopes: [...(transport.scopes ?? [])],
            clientInfo: clientInfoMessageOf(transport.clientInfo),
          },
        },
      }
    : {
        kind: {
          case: 'stdio',
          value: {
            command: transport.command,
            args: [...transport.args],
            cwd: transport.cwd,
            env: transport.env.map(entryMessageOf),
            clientInfo: clientInfoMessageOf(transport.clientInfo),
          },
        },
      };

/** A server input as the wire's `McpServerInput` (absent `scopes` → empty). Pure. */
export const serverInputMessageOf = (
  input: McpServerInput,
): MessageInitShape<typeof McpServerInputSchema> => ({
  name: input.name,
  enabled: input.enabled,
  transport: transportMessageOf(input.transport),
});

/** An entry message as today's `{name, value}` / `{name, credentialId}`. */
const entryOf = (entry: McpEntryMessage): unknown => {
  switch (entry.source.case) {
    case 'value':
      return { name: entry.name, value: entry.source.value };
    case 'credentialId':
      return { name: entry.name, credentialId: entry.source.value };
    default:
      return { name: entry.name };
  }
};

/** A `clientInfo` message with its absent fields left out. */
const clientInfoOf = (
  info: McpClientInfoMessage | undefined,
): Record<string, unknown> =>
  info === undefined
    ? {}
    : {
        clientInfo: {
          ...(info.name === undefined ? {} : { name: info.name }),
          ...(info.version === undefined ? {} : { version: info.version }),
        },
      };

/** A transport message as today's `{kind, …}`, absent optionals and an empty `scopes` left out. */
const transportOf = (transport: McpTransportMessage | undefined): unknown => {
  switch (transport?.kind.case) {
    case 'http': {
      const http = transport.kind.value;
      return {
        kind: 'http',
        url: http.url,
        headers: http.headers.map(entryOf),
        ...(http.clientName === undefined
          ? {}
          : { clientName: http.clientName }),
        ...(http.scopes.length === 0 ? {} : { scopes: [...http.scopes] }),
        ...clientInfoOf(http.clientInfo),
      };
    }
    case 'stdio': {
      const stdio = transport.kind.value;
      return {
        kind: 'stdio',
        command: stdio.command,
        args: [...stdio.args],
        ...(stdio.cwd === undefined ? {} : { cwd: stdio.cwd }),
        env: stdio.env.map(entryOf),
        ...clientInfoOf(stdio.clientInfo),
      };
    }
    default:
      return undefined;
  }
};

/** An optional field: present only when set. */
const optional = <K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: string } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };

/**
 * A wire `McpServerView` as today's view; an absent one or one outside
 * `mcpServerViewSchema` is `invalid_output`.
 */
export const serverViewOf = (
  message: McpServerViewMessage | undefined,
): McpServerView => {
  const parsed = mcpServerViewSchema.safeParse(
    message === undefined
      ? undefined
      : {
          name: message.name,
          enabled: message.enabled,
          transport: transportOf(message.transport),
          id: message.id,
          projectId: message.projectId,
          status:
            message.status === undefined
              ? undefined
              : {
                  state: message.status.state,
                  ...optional('message', message.status.message),
                },
          signedIn: message.signedIn,
          tools: message.tools.map((tool) => ({
            name: tool.name,
            ...optional('title', tool.title),
            ...optional('description', tool.description),
          })),
          skills: message.skills.map((skill) => ({
            uri: skill.uri,
            name: skill.name,
            description: skill.description,
          })),
        },
  );
  if (!parsed.success)
    throw new ContractError(
      'invalid_output',
      `mcp/v1 answered outside its schema: ${parsed.error.message}`,
    );
  return parsed.data;
};

/**
 * A wire `CredentialDescription` as today's public view; an absent one or
 * one outside `credentialDescriptionSchema` is `invalid_output`.
 */
export const credentialOf = (
  message: CredentialDescriptionMessage | undefined,
): CredentialDescription => {
  const parsed = credentialDescriptionSchema.safeParse(
    message === undefined
      ? undefined
      : {
          id: message.id,
          kind: message.kind,
          name: message.name,
          ...optional('username', message.username),
          ...optional('email', message.email),
          hasSecret: message.hasSecret,
        },
  );
  if (!parsed.success)
    throw new ContractError(
      'invalid_output',
      `secrets/v1 answered outside its schema: ${parsed.error.message}`,
    );
  return parsed.data;
};
