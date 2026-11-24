// P2 (phase 3, S59c, D1): one scripted session — create an HTTP and a stdio
// server, watch them connect, call a tool answering an image, move the HTTP
// server to a new URL, remove the stdio server, delete the Project — run on
// the kernel world (`world.ts`, `activate` of `index.ts`) and on the router
// world (`createMcpHost` over `createTestRouter`) leaves equal stored
// documents and server lists after every step (ids and times normalised),
// equal tool answers, equal registered tool names and definitions, equal
// process command lines and environments and equal credential names.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { create, type JsonValue } from '@bufbuild/protobuf';

import { McpServerViewSchema } from '../src/contracts/gen/doric/mcp/v1/mcp_pb.js';
import type { McpServerInput } from '../src/contracts/index.js';
import { serverViewMessageOf } from '../src/host/codec.js';
import {
  type FakeTool,
  type HttpMcpServer,
  textTool,
} from './support/mcp-server.js';
import { activated, P1, type View, viewOf } from './support/router.js';
import { opened, served } from './support/setup.js';
import { eventually } from './support/wait.js';
import { httpServer, stdioServer } from './support/world.js';

/** What one world lets the script do and observe. */
interface Session {
  create(input: McpServerInput): Promise<string>;
  update(id: string, input: McpServerInput): Promise<void>;
  remove(id: string): Promise<void>;
  /** Watches P1 until the servers are connected. */
  connected(ids: readonly string[]): Promise<void>;
  execute(name: string): Promise<unknown>;
  projectDeleted(): void;
  list(): Promise<readonly View[]>;
  documents(): readonly unknown[];
  liveNames(): readonly string[];
  tools(): readonly {
    name: string;
    description?: string;
    inputSchema: unknown;
  }[];
  processes(): readonly unknown[];
  credentialNames(): readonly string[];
}

/** What the script observed after each step, normalised. */
interface Trace {
  readonly steps: readonly {
    readonly documents: unknown;
    readonly servers: unknown;
  }[];
  readonly answer: unknown;
  readonly tools: unknown;
  readonly processes: unknown;
  readonly credentialNames: unknown;
}

const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

const snap: FakeTool = {
  tool: {
    name: 'snap',
    description: 'Takes a picture.',
    inputSchema: { type: 'object', properties: {} },
  },
  call: () => ({
    content: [
      { type: 'text', text: 'Here:' },
      { type: 'image', data: IMAGE, mimeType: 'image/png' },
    ],
  }),
};

/** Replaces server ids by their creation order, times by a marker and attachment ids by a marker. */
const normalised = (value: unknown, ids: readonly string[]): unknown => {
  let text = JSON.stringify(value) ?? 'null';
  ids.forEach((id, index) => {
    text = text.replaceAll(id, `server-${String(index + 1)}`);
  });
  text = text
    .replaceAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/gu, '<time>')
    .replaceAll(/sha256-[0-9a-f]{64}/gu, '<attachment>');

  return JSON.parse(text) as JsonValue;
};

const script = async (
  session: Session,
  first: HttpMcpServer,
  second: HttpMcpServer,
): Promise<Trace> => {
  const ids: string[] = [];
  const steps: { documents: unknown; servers: unknown }[] = [];
  const step = async () => {
    steps.push({
      documents: normalised(
        [...session.documents()].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
        ids,
      ),
      servers: normalised(await session.list(), ids),
    });
  };

  const docs = await session.create(
    httpServer('docs', first.url, [{ name: 'X-Mode', value: 'test' }]),
  );
  ids.push(docs);
  const files = await session.create(
    stdioServer(
      'files',
      'node',
      ['server.js'],
      [{ name: 'MODE', value: 'test' }],
    ),
  );
  ids.push(files);
  await session.connected([docs, files]);
  await eventually(
    () => session.liveNames().length === 2,
    'both servers registered their tools',
    () => session.liveNames(),
  );
  await step();

  const answer = normalised(await session.execute('mcp__docs__snap'), ids);

  await session.update(docs, httpServer('docs', second.url));
  await eventually(
    () => session.liveNames().join() === 'mcp__docs__alpha,mcp__files__echo',
    'the moved server registered its tools',
    () => session.liveNames(),
  );
  await step();

  await session.remove(files);
  await eventually(
    () => session.liveNames().join() === 'mcp__docs__alpha',
    'the stdio server unregistered its tool',
    () => session.liveNames(),
  );
  await step();

  session.projectDeleted();
  await eventually(
    () => session.documents().length === 0 && session.liveNames().length === 0,
    'the Project forgotten',
    () => session.documents(),
  );
  await step();

  return {
    steps,
    answer,
    tools: [...session.tools()].sort((a, b) => a.name.localeCompare(b.name)),
    processes: session.processes(),
    credentialNames: [...session.credentialNames()].sort(),
  };
};

void test('P2: one scripted session leaves equal documents, lists, answers, tools, processes and credential names on the kernel and on the router', async (t) => {
  const first = await served(t, { tools: [snap] });
  const second = await served(t, { tools: [textTool('alpha')] });

  const kernel = await opened(t);
  const kernelTrace = await script(
    {
      create: async (input) => (await kernel.mcp(P1).create(input)).id,
      update: async (id, input) => {
        await kernel.mcp(P1).update({ id, ...input });
      },
      remove: async (id) => {
        await kernel.mcp(P1).remove({ id });
      },
      connected: async (ids) => {
        await kernel.watchUntil(
          P1,
          (servers) =>
            ids.every((id) =>
              servers.some(
                (server) =>
                  server.id === id && server.status.state === 'connected',
              ),
            ),
          'connected',
        );
      },
      execute: (name) =>
        kernel.tool(P1, name).execute({}, kernel.promptCall(P1)),
      projectDeleted: () => {
        kernel.notice({ kind: 'projectDeleted', projectId: P1 });
      },
      list: async () =>
        (await kernel.mcp(P1).list()).map((view) =>
          viewOf(create(McpServerViewSchema, serverViewMessageOf(view))),
        ),
      documents: () => kernel.env.serverDocuments(),
      liveNames: () => kernel.liveNames(P1),
      tools: () =>
        kernel.registrations.map(({ tool }) => ({
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          inputSchema: (tool as { definition?: { inputSchema?: unknown } })
            .definition?.inputSchema,
        })),
      processes: () =>
        kernel.env.sandbox.started.map(({ input }) => ({
          cmd: input.cmd,
          cwd: input.cwd,
          env: [...(input.env ?? [])].sort(),
          tty: input.tty,
        })),
      credentialNames: () =>
        kernel.env.secretCalls.created.map(({ name }) => name),
    },
    first,
    second,
  );

  const routed = await activated(t);
  const routedTrace = await script(
    {
      create: async (input) => (await routed.create(P1, input)).id,
      update: async (id, input) => {
        await routed.update(P1, id, input);
      },
      remove: async (id) => {
        await routed.mcp(P1).remove({ id });
      },
      connected: async (ids) => {
        await routed.watchUntil(
          P1,
          (servers) =>
            ids.every((id) =>
              servers.some(
                (server) =>
                  server.id === id && server.status.state === 'connected',
              ),
            ),
          'connected',
        );
      },
      execute: (name) => routed.execute(name, P1, {}),
      projectDeleted: () => {
        routed.watches[0]?.push({
          notice: { case: 'projectDeleted', value: { projectId: P1 } },
        });
      },
      list: () => routed.list(P1),
      documents: () => routed.documents(),
      liveNames: () => routed.liveNames(P1),
      tools: () =>
        routed.registrations.map(({ name, description, inputSchema }) => ({
          name,
          ...(description === undefined ? {} : { description }),
          inputSchema,
        })),
      processes: () =>
        routed.sandbox.started.map(({ input }) => ({
          cmd: input.cmd,
          cwd: input.cwd,
          env: [...(input.env ?? [])].sort(),
          tty: input.tty,
        })),
      credentialNames: () =>
        routed
          .callsOf('secrets.create')
          .map(({ request }) => String((request as { name?: unknown }).name)),
    },
    first,
    second,
  );

  assert.deepEqual(routedTrace, kernelTrace);
});
