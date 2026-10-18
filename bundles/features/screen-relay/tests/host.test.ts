// The `screen-relay` host part: activation mounts the relay on the native
// listeners `doric.network/v1` hands it — the router and the `http.Server` —
// and provides `screen.relay/v1`, the contract the generation-side `screen`
// bundle publishes each session's upstream through. Deactivation releases both.
//
// The services object is a seam like `createTestServices`, one level up: the
// platform contract it stands in for is `doric.*`, which `bundle/contracts`
// only lets the platform define, so this test hands the host part the two
// functions it uses — `use` and `provide` — and drives what it provided.

import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';

import {
  type Disposable,
  DoricNetworkV1,
  type Services,
} from 'bundle/contracts';

import { ScreenRelayV1 } from '../src/contracts/index.js';
import { activate } from '../src/host/index.js';

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

/**
 * The host's shared router, reduced to the `use` the relay mounts through:
 * middleware runs in order and `next()` continues, as on the host's Express
 * app.
 */
class Router {
  readonly #stack: Middleware[] = [];

  use(handler: Middleware): unknown {
    this.#stack.push(handler);

    return undefined;
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    let index = 0;
    const next = (): void => {
      const handler = this.#stack[index];
      index += 1;

      if (handler === undefined) {
        response.writeHead(404);
        response.end();

        return;
      }

      handler(request, response, next);
    };

    next();
  }
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );

  return (server.address() as AddressInfo).port;
};

/** The xpra side of one screen, reduced to what the relay forwards. */
const upstream = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(`upstream ${request.url ?? ''}`);
});
const upstreamReady = listen(upstream);

const servers: Server[] = [];

/** One method of a provided definition, as this test drives it. */
interface Executor {
  readonly execute: (input: unknown) => unknown;
}

interface Provided {
  readonly id: string;
  readonly methods: Readonly<Record<string, Executor>>;
}

/**
 * The host's native listener plus `doric.network/v1`. The kernel runs the
 * listener inside `register` and disposes its cleanup with the registration, and
 * so does this: the relay is mounted by the time `register` answers.
 */
const nativeHost = () => {
  const router = new Router();
  const server = createServer((request, response) =>
    router.handle(request, response),
  );

  servers.push(server);

  let registrations = 0;

  return {
    server,
    registrations: () => registrations,
    register: (
      listener: (resources: {
        http: object;
        server: object;
        sockets: object;
      }) => (() => void) | undefined,
    ): Disposable => {
      registrations += 1;

      const cleanup = listener({ http: router, server, sockets: {} });
      let released = false;

      return {
        dispose: () => {
          if (released) return;

          released = true;
          cleanup?.();
        },
      };
    },
  };
};

const requestOver = (
  port: number,
  path: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const client = httpRequest(
      { host: '127.0.0.1', port, path },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );

    client.on('error', reject);
    client.end();
  });

after(async () => {
  await upstreamReady;

  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );

  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

test('activation mounts the relay on the native listener and provides the contract', async () => {
  const host = nativeHost();
  const provided: Provided[] = [];
  const services = {
    use: (ref: unknown) => {
      assert.equal(ref, DoricNetworkV1, 'the host part asks for its own seam');

      return { register: host.register };
    },
    provide: (definition: unknown) => {
      provided.push(definition as Provided);
    },
  } as unknown as Services;
  const upstreamPort = await upstreamReady;
  const port = await listen(host.server);

  try {
    const cleanup = await activate({ services });

    assert.equal(host.registrations(), 1, 'one registration was taken');
    assert.equal(provided.length, 1, 'one service was provided');
    assert.equal(
      provided[0]?.id,
      ScreenRelayV1.id,
      'the relay contract is the one provided',
    );
    assert.equal(
      host.server.listenerCount('upgrade'),
      1,
      'the relay answers upgrades on the shared server',
    );

    const expose = provided[0]?.methods.expose;
    const forget = provided[0]?.methods.forget;

    assert.equal(typeof expose?.execute, 'function');
    assert.equal(typeof forget?.execute, 'function');

    await expose?.execute({
      token: 't1',
      host: '127.0.0.1',
      port: upstreamPort,
    });
    assert.deepEqual(await requestOver(port, '/screen/t1/'), {
      status: 200,
      body: 'upstream /',
    });

    await forget?.execute({ token: 't1' });
    assert.equal((await requestOver(port, '/screen/t1/')).status, 404);

    await expose?.execute({
      token: 't2',
      host: '127.0.0.1',
      port: upstreamPort,
    });

    assert.equal(typeof cleanup, 'function');
    await (cleanup as () => void)();

    assert.equal(
      host.server.listenerCount('upgrade'),
      0,
      'the upgrade listener is handed back on deactivation',
    );
    assert.equal(
      (await requestOver(port, '/screen/t2/')).status,
      404,
      'the relay stops answering once the bundle deactivates',
    );
  } finally {
    await new Promise<void>((resolve) => host.server.close(() => resolve()));
  }
});
