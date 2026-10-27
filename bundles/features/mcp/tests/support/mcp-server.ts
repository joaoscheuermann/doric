// Real MCP servers built with the SDK, standing for the third-party servers a
// Project configures: one tool set served over any transport, a Streamable
// HTTP endpoint (or a legacy SSE-only one) on 127.0.0.1:0, optionally guarded
// by OAuth bearer tokens with protected-resource metadata.

import { randomUUID } from 'node:crypto';
import {
  createServer,
  type Server as HttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  type ClientCapabilities,
  ListToolsRequestSchema,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** The MCP Skills extension's identifier in `capabilities.extensions`. */
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

/** One skill a fake server lists through `skills/list`. */
export interface FakeSkill {
  readonly uri: string;
  readonly frontmatter: Readonly<Record<string, unknown>> & {
    readonly name: string;
    readonly description: string;
  };
  readonly resources: string;
}

/** A skill at `skill://<name>/SKILL.md`, with extra frontmatter fields. */
export const fakeSkill = (
  name: string,
  description: string,
  extra: Readonly<Record<string, unknown>> = {},
): FakeSkill => ({
  uri: `skill://${name}/SKILL.md`,
  frontmatter: { name, description, ...extra },
  resources: 'dynamic',
});

/**
 * The skills a fake server serves: its `skills/list` pages, in order, or
 * `fails` for a listing that answers an error. Given, the server declares the
 * Skills extension; absent, it declares nothing.
 */
export type FakeSkills = readonly (readonly FakeSkill[])[] | 'fails';

const SkillsListRequestSchema = z.object({
  method: z.literal('skills/list'),
  params: z.object({ cursor: z.string().optional() }).loose().optional(),
});

/** One tool a fake server offers, with how it answers a call. */
export interface FakeTool {
  readonly tool: Tool;
  readonly call?: (
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => CallToolResult | Promise<CallToolResult>;
}

/** One `tools/call` a fake server received. */
export interface ReceivedCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** A tool set served to every session connected to it. */
export interface ToolServer {
  readonly calls: readonly ReceivedCall[];
  /** The cursor of each `skills/list` request received, in order. */
  readonly skillCursors: readonly (string | undefined)[];
  /** The capabilities the client of the last session declared. */
  clientCapabilities(): ClientCapabilities | undefined;
  /** Replaces the tools every session lists from now on. */
  setTools(tools: readonly FakeTool[]): void;
  /** Serves one more MCP session over the transport. */
  connect(transport: Transport): Promise<void>;
  /** Sends `notifications/tools/list_changed` on every open session. */
  notifyToolsChanged(): Promise<void>;
  close(): Promise<void>;
}

/** A text-only tool answering `<name>: <args as JSON>`. */
export const textTool = (
  name: string,
  inputSchema: Tool['inputSchema'] = { type: 'object', properties: {} },
): FakeTool => ({
  tool: { name, description: `The ${name} tool.`, inputSchema },
  call: (args) => ({
    content: [{ type: 'text', text: `${name}: ${JSON.stringify(args)}` }],
  }),
});

export const toolServer = (
  initial: readonly FakeTool[],
  skills?: FakeSkills,
): ToolServer => {
  let tools = [...initial];
  const servers = new Set<Server>();
  const calls: ReceivedCall[] = [];
  const skillCursors: (string | undefined)[] = [];
  let last: Server | undefined;

  const capabilities: ServerCapabilities =
    skills === undefined
      ? { tools: { listChanged: true } }
      : {
          tools: { listChanged: true },
          resources: {},
          extensions: { [SKILLS_EXTENSION]: {} },
        };

  return {
    calls,
    skillCursors,
    clientCapabilities: () => last?.getClientCapabilities(),
    setTools: (next) => {
      tools = [...next];
    },
    connect: async (transport) => {
      const server = new Server(
        { name: 'fake-mcp', version: '1.0.0' },
        { capabilities },
      );
      last = server;

      server.setRequestHandler(SkillsListRequestSchema, (request) => {
        const cursor = request.params?.cursor;
        skillCursors.push(cursor);

        if (skills === 'fails') {
          throw new Error('The skills listing failed.');
        }

        const pages = skills ?? [[]];
        const index = cursor === undefined ? 0 : Number(cursor.slice(5));
        const result: {
          skills: readonly FakeSkill[];
          nextCursor?: string;
        } =
          index + 1 < pages.length
            ? { skills: pages[index] ?? [], nextCursor: `page-${index + 1}` }
            : { skills: pages[index] ?? [] };

        return result;
      });

      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: tools.map((entry) => entry.tool),
      }));

      server.setRequestHandler(
        CallToolRequestSchema,
        async (request, extra): Promise<CallToolResult> => {
          const args = request.params.arguments ?? {};
          calls.push({ name: request.params.name, arguments: args });
          const entry = tools.find(
            (candidate) => candidate.tool.name === request.params.name,
          );

          if (entry?.call === undefined) {
            return {
              content: [
                { type: 'text', text: `No tool ${request.params.name}.` },
              ],
              isError: true,
            };
          }

          return await entry.call(args, extra.signal);
        },
      );

      server.onclose = () => {
        servers.delete(server);
      };
      servers.add(server);
      await server.connect(transport);
    },
    notifyToolsChanged: async () => {
      await Promise.all(
        [...servers].map((server) =>
          server.sendToolListChanged().catch(() => undefined),
        ),
      );
    },
    close: async () => {
      await Promise.all([...servers].map((server) => server.close()));
    },
  };
};

/** One request that reached the MCP endpoint, before any authorization. */
export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

export interface HttpMcpOptions {
  readonly tools: readonly FakeTool[];
  /** The skills it serves; absent, it does not declare the Skills extension. */
  readonly skills?: FakeSkills;
  /** `streamable` (default) or a legacy server that speaks only HTTP+SSE. */
  readonly mode?: 'streamable' | 'sse';
  /**
   * Guards the endpoint with bearer tokens: a request without one of
   * `tokens` answers 401 naming the protected-resource metadata, which
   * points at `authorizationServer`.
   */
  readonly auth?: {
    readonly authorizationServer: () => string;
    readonly tokens: ReadonlySet<string>;
  };
}

export interface HttpMcpServer {
  /** The endpoint a Project configures: `http://127.0.0.1:<port>/mcp`. */
  readonly url: string;
  readonly tools: ToolServer;
  readonly requests: readonly ReceivedRequest[];
  /** Server-to-client event streams still open (GET streams, SSE). */
  openStreams(): number;
  /**
   * Forgets every session, as a restarted server would: a request naming one
   * answers 404, and a new initialize opens a new session.
   */
  restart(): Promise<void>;
  close(): Promise<void>;
}

const listen = async (server: HttpServer): Promise<number> => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return (server.address() as AddressInfo).port;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Serves the tool set on 127.0.0.1:0 over Streamable HTTP or legacy SSE. */
export const httpMcpServer = async (
  options: HttpMcpOptions,
): Promise<HttpMcpServer> => {
  const tools = toolServer(options.tools, options.skills);
  const requests: ReceivedRequest[] = [];
  const streamable = new Map<string, StreamableHTTPServerTransport>();
  const sse = new Map<string, SSEServerTransport>();
  let streams = 0;
  let base = '';

  const metadata = () => ({
    resource: `${base}/mcp`,
    authorization_servers: [options.auth?.authorizationServer() ?? ''],
  });

  const authorized = (req: IncomingMessage): boolean => {
    if (options.auth === undefined) {
      return true;
    }

    const header = req.headers.authorization ?? '';

    return (
      header.startsWith('Bearer ') &&
      options.auth.tokens.has(header.slice('Bearer '.length))
    );
  };

  const track = (res: ServerResponse): void => {
    streams += 1;
    res.on('close', () => {
      streams -= 1;
    });
  };

  const serveStreamable = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'];
    const known =
      typeof sessionId === 'string' ? streamable.get(sessionId) : undefined;

    if (req.method === 'GET' && known !== undefined) {
      track(res);
    }

    if (known !== undefined) {
      await known.handleRequest(req, res);
      return;
    }

    if (typeof sessionId === 'string') {
      json(res, 404, { error: 'unknown session' });
      return;
    }

    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }

    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          streamable.set(id, transport);
        },
        onsessionclosed: (id) => {
          streamable.delete(id);
        },
      });

    await tools.connect(transport);
    await transport.handleRequest(req, res);
  };

  const serveSse = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    if (url.pathname === '/mcp' && req.method === 'GET') {
      track(res);
      const transport = new SSEServerTransport('/messages', res);
      sse.set(transport.sessionId, transport);
      res.on('close', () => {
        sse.delete(transport.sessionId);
      });
      await tools.connect(transport);
      return;
    }

    if (url.pathname === '/messages' && req.method === 'POST') {
      const transport = sse.get(url.searchParams.get('sessionId') ?? '');

      if (transport === undefined) {
        json(res, 404, { error: 'unknown session' });
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    }

    json(res, 405, { error: 'method not allowed' });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (options.auth === undefined) {
        json(res, 404, { error: 'not found' });
      } else {
        json(res, 200, metadata());
      }
      return;
    }

    if (url.pathname !== '/mcp' && url.pathname !== '/messages') {
      json(res, 404, { error: 'not found' });
      return;
    }

    requests.push({
      method: req.method ?? '',
      path: url.pathname,
      headers: req.headers,
    });

    if (!authorized(req)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }

    const serve =
      options.mode === 'sse'
        ? serveSse(req, res, url)
        : serveStreamable(req, res);

    serve.catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { error: String(error) });
      }
    });
  });

  const port = await listen(server);
  base = `http://127.0.0.1:${port}`;

  return {
    url: `${base}/mcp`,
    tools,
    requests,
    openStreams: () => streams,
    restart: async () => {
      const sessions = [...streamable.values(), ...sse.values()];
      streamable.clear();
      sse.clear();
      await Promise.all(sessions.map((session) => session.close()));
    },
    close: async () => {
      await tools.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

/** An http URL on 127.0.0.1 where nothing listens any more. */
export const unreachableUrl = async (): Promise<string> => {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  return `http://127.0.0.1:${port}/mcp`;
};
