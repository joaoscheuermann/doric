// Dev-only: the fake host's HTTP + Socket.IO server.
//
// Two surfaces, as the real host has them:
//
//  - `POST`-less REST over HTTP (`/status`, `/projects`, …) for anything that
//    reaches the host without the bridge.
//  - the Socket.IO namespace `/doric/bridge`, where every message is emitted
//    under its `kind` and carries the whole envelope (`app/backend/doric-host/src/lib/bridge/socket.ts`
//    is the real implementation this follows).
//
// Every call is logged. A contract the fake host does not answer is refused
// with `unavailable` and logged as unknown: that log is how the served set
// grows.

import { createServer } from 'node:http';

import { Server } from 'socket.io';

import { unavailable } from './contracts.mjs';

export const BRIDGE_NAMESPACE = '/doric/bridge';

const wireErrorOf = (error) => ({
  code: typeof error?.code === 'string' ? error.code : 'unavailable',
  message: error instanceof Error ? error.message : String(error),
});

/** One request's summary: `GET /status → 200`. */
const describe = (method, url) => `${method} ${url}`;

const startRest = ({ server, workspace, catalog, log, version, reload }) => {
  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status, body) => {
      const payload = JSON.stringify(body);

      log.note(
        `rest ${describe(request.method ?? 'GET', url.pathname)} → ${status}`,
      );
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    };
    const segments = url.pathname.split('/').filter((part) => part !== '');

    if (request.method !== 'GET') {
      send(405, {
        error: { message: 'The development fake host is read-only.' },
      });

      return;
    }

    if (url.pathname === '/' || url.pathname === '/status') {
      send(200, {
        status: 'ok',
        service: 'doric-fake-host',
        version,
        generation: catalog.current().catalog.generation,
        bundles: catalog.current().bundleIds,
      });

      return;
    }

    if (url.pathname === '/projects') {
      send(200, workspace.projectPage({ limit: 100 }));

      return;
    }

    if (segments.length === 2 && segments[0] === 'projects') {
      const found = workspace.projectById(segments[1]);

      send(
        found === undefined ? 404 : 200,
        found ?? { error: { message: 'The project was not found.' } },
      );

      return;
    }

    if (url.pathname === '/threads') {
      const projectId = url.searchParams.get('projectId') ?? '';

      send(200, workspace.threadPage({ projectId, limit: 100 }));

      return;
    }

    if (url.pathname === '/reload') {
      reload()
        .then((generation) => send(200, { generation }))
        .catch((error) =>
          send(500, {
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );

      return;
    }

    send(404, { error: { message: `No ${url.pathname} on the fake host.` } });
  });
};

const serveBridge = ({ socket, calls, streams, log }) => {
  const openStreams = new Map();

  const answer = (id, output) =>
    socket.emit('result', { kind: 'result', id, ok: true, output });
  const fail = (id, error) =>
    socket.emit('result', {
      kind: 'result',
      id,
      ok: false,
      error: wireErrorOf(error),
    });
  const end = (id, error) =>
    socket.emit('end', {
      kind: 'end',
      id,
      ...(error === undefined ? {} : { error: wireErrorOf(error) }),
    });

  socket.on('call', (message) => {
    const { id, contract, method, input } = message ?? {};

    void (async () => {
      const started = Date.now();
      const handler = calls.get(`${contract} ${method}`);

      if (handler === undefined) {
        log.unknownCall(contract, method, input);
        fail(id, unavailable(contract, method));

        return;
      }

      log.call(contract, method, input);

      try {
        const output = await handler(input);

        log.answered(contract, method, Date.now() - started);
        answer(id, output);
      } catch (error) {
        log.failed(contract, method, error);
        fail(id, error);
      }
    })();
  });

  socket.on('subscribe', (message) => {
    const { id, contract, method, input } = message ?? {};
    const started = Date.now();
    const handler = streams.get(`${contract} ${method}`);

    if (handler === undefined) {
      log.unknownCall(contract, method, input);
      end(id, unavailable(contract, method));

      return;
    }

    log.call(contract, method, input);

    const sink = {
      push: (item) =>
        socket.emit('event', { kind: 'event', id, values: [item] }),
      end: (error) => {
        openStreams.delete(id);
        log.answered(contract, method, Date.now() - started);
        end(id, error);
      },
    };

    openStreams.set(id, sink);

    try {
      handler(input, sink);
    } catch (error) {
      log.failed(contract, method, error);
      sink.end(error);
    }
  });

  socket.on('unsubscribe', (message) => {
    const stream = openStreams.get(message?.id);

    if (stream !== undefined) {
      openStreams.delete(message.id);
      stream.end();
    }
  });

  socket.on('cancel', (message) => {
    const stream = openStreams.get(message?.id);

    if (stream !== undefined) {
      openStreams.delete(message.id);
      stream.end();
    }
  });

  socket.on('disconnect', () => openStreams.clear());
};

/** Starts the fake host and resolves once it accepts connections. */
export const startFakeHost = async ({
  port,
  host,
  workspace,
  catalog,
  contracts,
  log,
  version,
  reload,
}) => {
  const server = createServer();

  startRest({ server, workspace, catalog, log, version, reload });

  const io = new Server(server, { serveClient: false });
  const bridge = io.of(BRIDGE_NAMESPACE);

  bridge.on('connection', (socket) => {
    log.note(`bridge: a desktop connected (${socket.id})`);
    serveBridge({ socket, ...contracts, log });
  });

  await new Promise((done, failed) => {
    server.once('error', failed);
    server.listen(port, host, () => done());
  });

  return {
    io,
    url: `http://${host}:${port}`,
    // `io.close` closes the HTTP server it was attached to as well.
    close: () => new Promise((done) => io.close(() => done())),
  };
};
