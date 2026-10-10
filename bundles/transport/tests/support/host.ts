import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  type AnyServiceDefinition,
  type Call,
  defineMethod,
  defineService,
  ModelsV1,
  modelsMethods,
  SecretsV1,
  secretsMethods,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import express from 'express';
import { FilesV1, filesMethods } from 'files/contracts';
import { GitCommandsV1, gitMethods } from 'git/contracts';
import { pino } from 'pino';
import { ResourcesV1, resourcesMethods } from 'resources/contracts';
import {
  ConfigurationV1,
  configurationMethods,
  RuntimeLeaseV1,
  RuntimeThreadsV1,
  RuntimeV1,
  runtimeLeaseMethods,
  runtimeMethods,
  runtimeThreadsMethods,
  SandboxV1,
  sandboxMethods,
} from 'runtime/contracts';
import { Server as SocketServer } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { TerminalServiceV1, terminalServiceMethods } from 'terminal/contracts';
import { UsageV1, usageMethods } from 'usage/contracts';
import type { z } from 'zod';

import { createTransport } from '../../src/kernel.js';

/*
 * The transport as the kernel embeds it: one HTTP server shared by Express
 * and Socket.IO, the bundle activated over in-process services, and every
 * contract it requires answered by a fake provider. A fake method takes the
 * caller's arguments, then the hop Call (whose scope a lease read binds).
 */

// biome-ignore lint/suspicious/noExplicitAny: a fake answers whatever its case needs
type FakeMethod = (...args: any[]) => unknown;
export type Fake = Readonly<Record<string, FakeMethod>>;

export interface Fakes {
  readonly runtime?: Fake;
  readonly threads?: Fake;
  /** runtime.lease/v1: only `ssh` since the stage-10 host switch. */
  readonly lease?: Fake;
  /** The stage-10 feature bundles the routes call. */
  readonly files?: Fake;
  readonly git?: Fake;
  readonly usage?: Fake;
  readonly resources?: Fake;
  /** terminal/v1 1.1.0. */
  readonly terminal?: Fake;
  readonly sandbox?: Fake;
  readonly tools?: Fake;
  readonly models?: Fake;
  readonly secrets?: Fake;
  readonly configuration?: Fake;
}

type Specs = Readonly<
  Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>
>;

const isTuple = (schema: z.ZodType): boolean =>
  (schema as unknown as { _zod?: { def?: { type?: string } } })._zod?.def
    ?.type === 'tuple';

/** A provider of every method of a contract; one the case does not answer fails. */
const fakeService = (
  id: `${string}/v${number}`,
  methods: Specs,
  fake: Fake = {},
): AnyServiceDefinition =>
  defineService(
    id,
    Object.fromEntries(
      Object.entries(methods).map(([name, spec]) => [
        name,
        defineMethod({
          input: spec.input,
          output: spec.output,
          execute: (input: unknown, call: Call) => {
            const method = fake[name];

            if (method === undefined)
              throw new Error(`Unexpected ${id} ${name}.`);

            return isTuple(spec.input)
              ? method(...(input as unknown[]), call)
              : method(input, call);
          },
        }),
      ]),
    ),
  );

export interface Host {
  readonly url: string;
  readonly io: SocketServer;
  request(path: string, method?: string, body?: unknown): Promise<Response>;
  /** A Socket.IO client of one namespace, with no reconnection. */
  connect(
    namespace: string,
    auth?: Readonly<Record<string, string | number>>,
  ): ReturnType<typeof connect>;
  engineConnections(): number;
  close(): Promise<void>;
}

/** Boots the transport bundle over the fakes and listens on a free port. */
export const serve = async (fakes: Fakes = {}): Promise<Host> => {
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);
  let engineConnections = 0;
  io.engine.on('connection', () => {
    engineConnections += 1;
  });
  const services = createTestServices({
    bundle: { id: 'transport' },
    provide: [
      fakeService(RuntimeV1.id, runtimeMethods, {
        // The transport subscribes on activation; most cases publish nothing.
        watch: () => ({ dispose: () => undefined }),
        ...fakes.runtime,
      }),
      fakeService(RuntimeThreadsV1.id, runtimeThreadsMethods, fakes.threads),
      fakeService(RuntimeLeaseV1.id, runtimeLeaseMethods, fakes.lease),
      fakeService(FilesV1.id, filesMethods, fakes.files),
      fakeService(GitCommandsV1.id, gitMethods, fakes.git),
      fakeService(UsageV1.id, usageMethods, fakes.usage),
      fakeService(ResourcesV1.id, resourcesMethods, fakes.resources),
      fakeService(TerminalServiceV1.id, terminalServiceMethods, {
        // The socket watches each subscribed Project; most cases emit nothing.
        watchProject: () => ({ dispose: () => undefined }),
        ...fakes.terminal,
      }),
      fakeService(SandboxV1.id, sandboxMethods, fakes.sandbox),
      fakeService(ToolsV1.id, toolsMethods, fakes.tools),
      fakeService(ModelsV1.id, modelsMethods, fakes.models),
      fakeService(SecretsV1.id, secretsMethods, fakes.secrets),
      fakeService(
        ConfigurationV1.id,
        configurationMethods,
        fakes.configuration,
      ),
    ],
  });
  const bundle = createTransport({
    app,
    io,
    logger: pino({ enabled: false }),
  });
  const activate = bundle.host?.activate;
  assert.ok(activate !== undefined);
  const cleanup = await activate({ services: services.services });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const url = `http://127.0.0.1:${String(address.port)}`;

  return {
    url,
    io,
    request: (path, method = 'GET', body) =>
      fetch(`${url}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
    connect: (namespace, auth = {}) =>
      connect(`${url}${namespace}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        auth,
      }),
    engineConnections: () => engineConnections,
    close: async () => {
      if (typeof cleanup === 'function') await cleanup();
      await services.dispose();
      // Closing Socket.IO closes the shared HTTP server too.
      await io.close();
    },
  };
};

/** The error envelope every refusal answers. */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
