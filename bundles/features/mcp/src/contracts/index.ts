// Public contract of the `mcp` bundle: the MCP (Model Context Protocol)
// servers a Project connects to, and the tools they give its prompts. A
// server is either remote (`http`: Streamable HTTP, optionally behind OAuth)
// or a command the Project's sandbox runs (`stdio`). Every method is
// Project-scoped: it reads `call.scope.projectId`, and a call without it is
// refused with ContractError('invalid_input', mcpScopeMessage). A connected
// server's tools are registered with `tools/v1` under that Project, so only
// that Project's prompts see them, named `mcp__<server slug>__<tool>`.
//
// Error codes raised by mcp/v1 (besides `invalid_input`):
//
// - `mcp_server_missing` (`update`, `remove`, `signIn`, `finishSignIn`): the
//   Project holds no server with that id.
// - `mcp_server_name_taken` (`create`, `update`): another server of the
//   Project has a name with the same slug.
// - `mcp_signin_unsupported` (`signIn`): the server is a `stdio` one.
// - `mcp_signin_not_started` (`finishSignIn`): no sign-in of that server waits.
// - `mcp_signin_busy` (`finishSignIn`): another `finishSignIn` waits on it.
// - `mcp_signin_aborted` (`signIn`, `finishSignIn`): the caller cancelled, a
//   newer `signIn` of the same server replaced it, or the server changed its
//   transport or URL, or was removed.
// - `mcp_signin_failed` (`signIn`, `finishSignIn`): discovery, registration,
//   the authorization or the token exchange failed; the message says which.
//
// This module is shared with the desktop part: it imports neither the MCP
// SDK nor any Node-only module.

import {
  type CallArg,
  type Disposable,
  disposableSchema,
  type MethodSpecs,
  noInput,
  ref,
  type StreamListener,
  streamListener,
} from 'bundle/contracts';
import { z } from 'zod';

/** The error codes mcp/v1 raises, besides the platform's `invalid_input`. */
export const mcpErrorCodes = [
  'mcp_server_missing',
  'mcp_server_name_taken',
  'mcp_signin_unsupported',
  'mcp_signin_not_started',
  'mcp_signin_busy',
  'mcp_signin_aborted',
  'mcp_signin_failed',
] as const;

export type McpErrorCode = (typeof mcpErrorCodes)[number];

/** The refusal of a call whose scope names no Project. */
export const mcpScopeMessage = 'mcp/v1 needs a Project scope.';

/** The longest server name, in characters, once trimmed. */
export const MCP_NAME_MAX = 64;

/**
 * One header or environment variable: a literal `value`, or the `secret` of
 * the stored credential `credentialId` names, read when the server connects
 * (never stored here, never shown back).
 */
export type McpEntry =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly credentialId: string };

/**
 * How Doric reaches the server: `http` is the Streamable HTTP transport at
 * `url` with extra request `headers`; `stdio` runs `command args` in the
 * Project's sandbox, in `cwd` (the sandbox's default when absent), with `env`
 * added to its environment.
 */
export type McpTransport =
  | {
      readonly kind: 'http';
      readonly url: string;
      readonly headers: readonly McpEntry[];
    }
  | {
      readonly kind: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly env: readonly McpEntry[];
    };

/** What the reader edits: the server's name, whether it runs, and how to reach it. */
export interface McpServerInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: McpTransport;
}

/**
 * Where a server's connection stands:
 * - `disabled`: `enabled` is false; nothing runs and no tool is registered.
 * - `idle`: enabled, but no `watch` of its Project has connected it yet.
 * - `connecting`: the connection or the tool listing is in progress.
 * - `connected`: its tools are registered for the Project.
 * - `needs-sign-in`: the server asked for OAuth and no stored token works;
 *   `signIn` starts the browser authorization.
 * - `waiting-for-sandbox`: a `stdio` server whose Project holds no sandbox
 *   lease yet; it connects once the sandbox is up.
 * - `error`: the last attempt failed; `message` says why, with every
 *   credential secret masked.
 */
export const mcpStatuses = [
  'disabled',
  'idle',
  'connecting',
  'connected',
  'needs-sign-in',
  'waiting-for-sandbox',
  'error',
] as const;

export type McpStatus = (typeof mcpStatuses)[number];

/** One tool a connected server gives, as the Project's prompts see it. */
export interface McpToolView {
  /**
   * The tool's name as the MCP server gives it (what the reader recognises);
   * the Doric tool name is `mcp__<server slug>__<this, sanitized>`.
   */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
}

/**
 * One skill a connected server serves through the MCP Skills extension
 * (`io.modelcontextprotocol/skills`), as the reader sees it. Listed only:
 * Doric never loads a skill into a prompt.
 */
export interface McpSkillView {
  /** The URI of its SKILL.md: unique within the server (names need not be). */
  readonly uri: string;
  /** Its frontmatter `name`. */
  readonly name: string;
  /** Its frontmatter `description`. */
  readonly description: string;
}

/** One stored server of the Project, with its live state. */
export interface McpServerView extends McpServerInput {
  readonly id: string;
  readonly projectId: string;
  readonly status: { readonly state: McpStatus; readonly message?: string };
  /** Whether OAuth tokens are stored for it (always false for `stdio`). */
  readonly signedIn: boolean;
  /** Its registered tools; empty unless `status.state` is `connected`. */
  readonly tools: readonly McpToolView[];
  /**
   * The skills it lists (`skills/list`), in its order; empty unless
   * `status.state` is `connected`, the server declared the Skills extension
   * and its listing succeeded.
   */
  readonly skills: readonly McpSkillView[];
}

/** `mcp/v1` (host): the MCP servers of the Project of `call.scope.projectId`. */
export interface Mcp {
  /** The Project's servers in creation order, with their live state. A read: it never starts a connection. */
  list(call?: CallArg): Promise<readonly McpServerView[]>;
  /**
   * Stores a new server and answers it; an enabled one connects when its
   * Project is watched. `mcp_server_name_taken` when another server of the
   * Project has a name with the same slug; `invalid_input` when an entry
   * names an MCP_TOKEN credential (the sign-in of a server).
   */
  create(input: McpServerInput, call?: CallArg): Promise<McpServerView>;
  /**
   * Replaces the server's name, `enabled` and transport and reconnects it (or
   * stops it when disabled), answering the stored view. An update that
   * changes the transport kind or the http URL drops the stored OAuth state
   * and deletes its MCP_TOKEN credentials, and cancels its waiting sign-in.
   * `mcp_server_missing`, `mcp_server_name_taken`, `invalid_input` (as
   * `create`).
   */
  update(
    input: McpServerInput & { readonly id: string },
    call?: CallArg,
  ): Promise<McpServerView>;
  /**
   * Stops the server, unregisters its tools, deletes the MCP_TOKEN
   * credentials its sign-in stored, then the server, and cancels its waiting
   * sign-in. `mcp_server_missing`.
   */
  remove(input: { readonly id: string }, call?: CallArg): Promise<void>;
  /**
   * The Project's servers (as `list`) on subscribe, then after every change
   * of a server or of its state. Watching connects every enabled server of
   * the Project that is not connected yet; disposing the last watch keeps the
   * connections.
   */
  watch(
    listener: StreamListener<readonly McpServerView[]>,
    call?: CallArg,
  ): Disposable;
  /**
   * Prepares a browser OAuth sign-in of an `http` server and answers the
   * authorization URL to open; a sign-in of the same server already waiting
   * is replaced, another server's is left alone.
   * `mcp_server_missing`, `mcp_signin_unsupported` (a `stdio` server),
   * `mcp_signin_aborted` (the caller cancelled, or the server changed or
   * went away meanwhile), `mcp_signin_failed` (discovery or client
   * registration failed).
   */
  signIn(
    input: { readonly id: string },
    call?: CallArg,
  ): Promise<{ readonly url: string }>;
  /**
   * Waits for the browser to answer the started sign-in, stores the tokens
   * as MCP_TOKEN credentials, reconnects the server and answers its view.
   * `mcp_server_missing`, `mcp_signin_not_started`, `mcp_signin_busy`,
   * `mcp_signin_aborted`, `mcp_signin_failed`.
   */
  finishSignIn(
    input: { readonly id: string },
    call?: CallArg,
  ): Promise<McpServerView>;
}

/** An environment variable name a POSIX shell accepts. */
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** An HTTP header field name: an RFC 7230 token. */
const headerName = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);

const entrySchema = (name: z.ZodString): z.ZodType<McpEntry, McpEntry> =>
  z.union([
    z.object({ name, value: z.string() }).strict(),
    z.object({ name, credentialId: z.string().min(1) }).strict(),
  ]);

export const mcpTransportSchema: z.ZodType<McpTransport, McpTransport> =
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('http'),
        url: z.url({ protocol: /^https?$/ }),
        headers: z.array(entrySchema(headerName)),
      })
      .strict(),
    z
      .object({
        kind: z.literal('stdio'),
        command: z.string().min(1),
        args: z.array(z.string()),
        cwd: z.string().min(1).optional(),
        env: z.array(entrySchema(envName)),
      })
      .strict(),
  ]);

/**
 * A server name: trimmed, 1 to 64 characters, with at least one ASCII
 * letter, digit or `-`, so its slug (the tool-name prefix) is never empty.
 */
export const mcpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MCP_NAME_MAX)
  .regex(/[A-Za-z0-9-]/, 'A server name needs a letter, a digit or "-".');

export const mcpServerInputSchema = z
  .object({
    name: mcpServerNameSchema,
    enabled: z.boolean(),
    transport: mcpTransportSchema,
  })
  .strict();

export const mcpServerUpdateSchema = mcpServerInputSchema
  .extend({ id: z.string().min(1) })
  .strict();

export const mcpServerRefSchema = z.object({ id: z.string().min(1) }).strict();

export const mcpToolViewSchema: z.ZodType<McpToolView, McpToolView> = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

export const mcpSkillViewSchema: z.ZodType<McpSkillView, McpSkillView> = z
  .object({ uri: z.string(), name: z.string(), description: z.string() })
  .strict();

export const mcpServerViewSchema: z.ZodType<McpServerView, McpServerView> =
  mcpServerInputSchema
    .extend({
      id: z.string(),
      projectId: z.string(),
      status: z
        .object({
          state: z.enum(mcpStatuses),
          message: z.string().optional(),
        })
        .strict(),
      signedIn: z.boolean(),
      tools: z.array(mcpToolViewSchema),
      skills: z.array(mcpSkillViewSchema),
    })
    .strict();

/** The wire shapes of `mcp/v1`; every method is reachable from a desktop window. */
export const mcpMethods = {
  list: {
    input: noInput,
    output: z.array(mcpServerViewSchema),
    expose: 'desktop',
  },
  create: {
    input: mcpServerInputSchema,
    output: mcpServerViewSchema,
    expose: 'desktop',
  },
  update: {
    input: mcpServerUpdateSchema,
    output: mcpServerViewSchema,
    expose: 'desktop',
  },
  remove: { input: mcpServerRefSchema, output: z.void(), expose: 'desktop' },
  // The listener is the last tuple item: that marks the call as a stream.
  watch: {
    input: z.tuple([streamListener(z.array(mcpServerViewSchema))]),
    output: disposableSchema,
    expose: 'desktop',
  },
  signIn: {
    input: mcpServerRefSchema,
    output: z.object({ url: z.string() }).strict(),
    expose: 'desktop',
  },
  finishSignIn: {
    input: mcpServerRefSchema,
    output: mcpServerViewSchema,
    expose: 'desktop',
  },
} as const satisfies MethodSpecs;

/** `mcp/v1`, provided by the `mcp` bundle. */
export const McpV1 = ref<Mcp>('mcp/v1');
