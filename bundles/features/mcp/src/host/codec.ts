// The wire shapes of `mcp/v1` and `default.skill-sources/v1` as the domain's
// (phase 3, S59 D5): requests re-parsed with today's zod schemas, answers
// built from `McpServerView`.

import type { MessageInitShape } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import type { SkillSourceEntry } from 'default/contracts';
import type { SkillSourceEntrySchema } from 'default/contracts/gen/doric/default/skill_sources/v1/skill_sources_pb.js';

import type {
  McpClientInfo as McpClientInfoMessage,
  McpClientInfoSchema,
  McpEntry as McpEntryMessage,
  McpEntrySchema,
  McpServerInput as McpServerInputMessage,
  McpServerViewSchema,
  McpTransport as McpTransportMessage,
  McpTransportSchema,
} from '../contracts/gen/doric/mcp/v1/mcp_pb.js';
import {
  type McpClientInfo,
  type McpEntry,
  type McpServerInput,
  type McpServerView,
  type McpTransport,
  mcpServerInputSchema,
} from '../contracts/index.js';

/** An entry message as today's `{name, value}` / `{name, credentialId}` (no source: `undefined`, which zod refuses). */
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

/**
 * A `McpServerInput` message as today's domain input (D5): transport oneof → `{kind, …}`, entry oneof → `{name, value}`
 * / `{name, credentialId}`, empty `scopes` and absent optionals omitted; then `mcpServerInputSchema.parse` (names and
 * client names trimmed). Throws `ContractError('invalid_input', 'Invalid input for mcp/v1 <method>.', {issues})` when
 * zod refuses. Pure otherwise.
 */
export const serverInputOf = (
  message: McpServerInputMessage | undefined,
  method: 'Create' | 'Update',
): McpServerInput => {
  const result = mcpServerInputSchema.safeParse(
    message === undefined
      ? undefined
      : {
          name: message.name,
          enabled: message.enabled,
          transport: transportOf(message.transport),
        },
  );

  if (!result.success) {
    throw new ContractError(
      'invalid_input',
      `Invalid input for mcp/v1 ${method}.`,
      { issues: result.error.issues },
    );
  }

  return result.data;
};

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

/** A view as the wire's `McpServerView` (absent `status.message`, `title`, `description` stay absent; `scopes`
 *  absent → empty). Pure; never throws. */
export const serverViewMessageOf = (
  view: McpServerView,
): MessageInitShape<typeof McpServerViewSchema> => ({
  name: view.name,
  enabled: view.enabled,
  transport: transportMessageOf(view.transport),
  id: view.id,
  projectId: view.projectId,
  status: { state: view.status.state, message: view.status.message },
  signedIn: view.signedIn,
  tools: view.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
  })),
  skills: view.skills.map((skill) => ({
    uri: skill.uri,
    name: skill.name,
    description: skill.description,
  })),
});

/** A skill source entry as the wire's (absent `group` stays absent). Pure. */
export const skillSourceEntryMessageOf = (
  entry: SkillSourceEntry,
): MessageInitShape<typeof SkillSourceEntrySchema> => ({
  group: entry.group,
  name: entry.name,
  description: entry.description,
  reference: entry.reference,
});
