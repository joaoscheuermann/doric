// What the Electron tests boot: the real desktop platform over the built
// platform assets, a fake host (a Connect server over `node:http2` on this
// process's loopback port, the real network boundary, with the envelope's
// Socket.IO bridge beside it on the same port) and either a fixture shell
// whose bootstrap is desktop/client's or the real built renderer shell.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import {
  createServer as createHttp2Server,
  type ServerHttp2Session,
} from 'node:http2';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  create,
  type DescService,
  getOption,
  hasOption,
  toJson,
} from '@bufbuild/protobuf';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import {
  CatalogService,
  GetResponseSchema,
  ReadArtifactResponseSchema,
  WatchResponseSchema,
} from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import {
  DiagnosticsService,
  ReportResponseSchema,
} from 'bundle/contracts/gen/doric/platform/diagnostics/v1/diagnostics_pb.js';
import { contract as contractOption } from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import {
  catalogSnapshotMessage,
  type DistributionCatalog,
  distributionMessage,
} from 'bundle/runtime';
import { BrowserWindow, nativeTheme, type WebContents } from 'electron';
import { Server, type Socket } from 'socket.io';
import {
  ReadySchema,
  StatusService,
  WatchResponseSchema as StatusWatchResponseSchema,
} from 'transport/contracts/gen/doric/api/status/v1/status_pb.js';

import { DesktopPlatform } from '../../../doric/src/platform/app';
import type { HostForward } from '../../../doric/src/platform/bridge/connect-relay';
import { connectHost } from '../../../doric/src/platform/host/connect';
import {
  createPlatformLog,
  type PlatformLog,
  silentLog,
} from '../../../doric/src/platform/log';
import type { NotificationApi } from '../../../doric/src/platform/native/notifications';
import { resourcesFor } from '../../../doric/src/platform/protocol/resources';
import type { Clock } from '../../../doric/src/platform/splash/timing';

/** The built main process directory (`nx build doric-app` + its assets). */
export const MAIN_DIR = resolve('dist/app/desktop/doric');
export const PRELOAD = join(MAIN_DIR, 'preload.js');

/** What the fake answers an envelope call with now that the host is Connect. */
export const UNAVAILABLE_HOST_MESSAGE = 'Doric backend is unavailable.';

/** One call a served service received: its contract, method and input. */
export interface HostCall {
  readonly contract: string;
  readonly method: string;
  readonly input: unknown;
}

export interface FakeHost {
  readonly url: string;
  readonly calls: HostCall[];
  /** Publishes a new distribution and tells every `Watch` subscriber. */
  publish(
    catalog: DistributionCatalog,
    artifacts?: ReadonlyMap<string, Buffer>,
  ): void;
  /**
   * Ends the next `count` `StatusService.Watch` calls with `UNAVAILABLE` (the
   * host is starting, or down).
   */
  refuse(count: number): void;
  /**
   * Serves `service` with `implementation` over Connect, merging the methods it
   * omits into the ones a previous `serve` gave (or the fake's defaults).
   */
  serve<Desc extends DescService>(
    service: Desc,
    implementation: Partial<ServiceImpl<Desc>>,
  ): void;
  /**
   * Answers the window's Connect calls (`doric:connect`) of the host
   * contracts with `forward` when `bootPlatform` names no `hostForward`; a
   * later call replaces it.
   */
  forwardConnect(forward: HostForward): void;
  /** The Connect forward `forwardConnect` set last, if any. */
  readonly connect: HostForward | undefined;
  close(): Promise<void>;
}

/** The contract a service's `.proto` declares (`(doric.platform.v1.contract)`). */
const contractIdOf = (service: DescService): string =>
  hasOption(service.file, contractOption)
    ? getOption(service.file, contractOption).id
    : service.typeName;

/** Resolves when `signal` aborts (or at once, when it already has). */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((done) => {
    if (signal.aborted) {
      done();
    } else {
      signal.addEventListener('abort', () => done(), { once: true });
    }
  });

export const startFakeHost = async (input: {
  readonly catalog: DistributionCatalog;
  readonly artifacts: ReadonlyMap<string, Buffer | string>;
}): Promise<FakeHost> => {
  let catalog = input.catalog;
  const artifacts = new Map<string, Buffer>(
    [...input.artifacts].map(([hash, content]) => [hash, Buffer.from(content)]),
  );
  const calls: HostCall[] = [];
  /** Handlers of the Connect services served, by `typeName`. */
  const served = new Map<
    string,
    {
      readonly service: DescService;
      readonly implementation: Record<string, unknown>;
    }
  >();
  /** Every open `CatalogService.Watch`, told of each published catalog. */
  const watchers = new Set<(next: DistributionCatalog) => void>();
  let connect: HostForward | undefined;
  let refusals = 0;

  const catalogHandlers = (): Partial<ServiceImpl<typeof CatalogService>> => ({
    get: () =>
      create(GetResponseSchema, {
        catalogSnapshot: catalogSnapshotMessage(catalog.host),
      }),
    distribution: () => distributionMessage(catalog),
    readArtifact: async function* (request) {
      const bytes = artifacts.get(request.sha256);

      if (bytes === undefined) {
        throw new ConnectError(`No artifact ${request.sha256}.`, Code.NotFound);
      }

      yield create(ReadArtifactResponseSchema, {
        chunk: new Uint8Array(bytes),
      });
    },
    watch: async function* (_request, context) {
      const queue: DistributionCatalog[] = [];
      let wake: (() => void) | undefined;
      const push = (next: DistributionCatalog): void => {
        queue.push(next);
        wake?.();
        wake = undefined;
      };
      const signal = (): void => {
        wake?.();
        wake = undefined;
      };

      context.signal.addEventListener('abort', signal);
      watchers.add(push);

      try {
        yield create(WatchResponseSchema, {
          catalogSnapshot: catalogSnapshotMessage(catalog.host),
        });

        for (;;) {
          if (context.signal.aborted) {
            return;
          }

          const next = queue.shift();

          if (next === undefined) {
            await new Promise<void>((done) => {
              wake = done;
            });
            continue;
          }

          yield create(WatchResponseSchema, {
            catalogSnapshot: catalogSnapshotMessage(next.host),
          });
        }
      } finally {
        context.signal.removeEventListener('abort', signal);
        watchers.delete(push);
      }
    },
  });

  const statusHandlers = (): Partial<ServiceImpl<typeof StatusService>> => ({
    watch: async function* (_request, context) {
      if (refusals > 0) {
        refusals -= 1;

        throw new ConnectError('The host is starting.', Code.Unavailable);
      }

      yield create(StatusWatchResponseSchema, {
        event: { case: 'ready', value: create(ReadySchema) },
      });

      // The host stays reachable until the caller cancels.
      await aborted(context.signal);
    },
  });

  const diagnosticsHandlers = (): Partial<
    ServiceImpl<typeof DiagnosticsService>
  > => ({
    report: () => create(ReportResponseSchema, {}),
  });

  served.set(CatalogService.typeName, {
    service: CatalogService,
    implementation: { ...catalogHandlers() },
  });
  served.set(StatusService.typeName, {
    service: StatusService,
    implementation: { ...statusHandlers() },
  });
  served.set(DiagnosticsService.typeName, {
    service: DiagnosticsService,
    implementation: { ...diagnosticsHandlers() },
  });

  /** `implementation` with each method recording its call in `calls` first. */
  const recorded = <Desc extends DescService>(
    service: Desc,
    implementation: Partial<ServiceImpl<Desc>>,
  ): ServiceImpl<Desc> =>
    Object.fromEntries(
      Object.entries(implementation).map(([name, method]) => {
        const desc = service.methods.find((item) => item.localName === name);

        return [
          name,
          (request: unknown, context: unknown) => {
            calls.push({
              contract: contractIdOf(service),
              method: name,
              input:
                desc === undefined
                  ? request
                  : toJson(desc.input, request as never),
            });

            return (
              method as (request: unknown, context: unknown) => unknown
            )(request, context);
          },
        ];
      }),
    ) as ServiceImpl<Desc>;

  const adapter = (): ReturnType<typeof connectNodeAdapter> =>
    connectNodeAdapter({
      routes: (router) => {
        for (const { service, implementation } of served.values()) {
          router.service(
            service,
            recorded(
              service,
              implementation as Partial<ServiceImpl<DescService>>,
            ),
          );
        }
      },
    });

  let handle = adapter();

  const http = createHttpServer();
  const http2 = createHttp2Server((request, response) => {
    handle(request, response);
  });
  /** The open HTTP/2 sessions, so `close` can end the ones a forward holds. */
  const sessions = new Set<ServerHttp2Session>();

  http2.on('session', (session: ServerHttp2Session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  const io = new Server(http);
  const bridge = io.of('/doric/bridge');

  bridge.on('connection', (socket: Socket) => {
    socket.on('call', (message: { id: string } & HostCall) => {
      calls.push({
        contract: message.contract,
        method: message.method,
        input: message.input,
      });
      socket.emit('result', {
        kind: 'result',
        id: message.id,
        ok: false,
        error: { code: 'unavailable', message: UNAVAILABLE_HOST_MESSAGE },
      });
    });
    socket.on('subscribe', (message: { id: string } & HostCall) => {
      calls.push({
        contract: message.contract,
        method: message.method,
        input: message.input,
      });
      socket.emit('end', {
        kind: 'end',
        id: message.id,
        error: { code: 'unavailable', message: UNAVAILABLE_HOST_MESSAGE },
      });
    });
    socket.on('unsubscribe', () => undefined);
  });

  // One loopback port speaks both: HTTP/2 for Connect (main's forward and its
  // own calls) and HTTP/1.1 for the envelope's Socket.IO bridge. The HTTP/2
  // connection preface ("PRI …") tells them apart.
  const listener = createNetServer((socket) => {
    // Paused until the first bytes tell the protocols apart, so neither server
    // reads (and drops) them.
    socket.pause();

    const route = (): void => {
      const chunk = socket.read();

      if (chunk === null) {
        return;
      }

      socket.unshift(chunk);

      if (chunk.length < 3) {
        socket.once('readable', route);

        return;
      }

      if (chunk.subarray(0, 3).toString('latin1') === 'PRI') {
        http2.emit('connection', socket);
      } else {
        http.emit('connection', socket);
      }
    };

    socket.once('readable', route);
  });

  await new Promise<void>((done) =>
    listener.listen(0, '127.0.0.1', () => done()),
  );

  const { port } = listener.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    publish: (next, more) => {
      catalog = next;

      for (const [hash, bytes] of more ?? []) {
        artifacts.set(hash, bytes);
      }

      for (const push of [...watchers]) {
        push(next);
      }
    },
    refuse: (count) => {
      refusals = count;
    },
    serve: (service, implementation) => {
      const prior = served.get(service.typeName)?.implementation ?? {};

      served.set(service.typeName, {
        service,
        implementation: {
          ...prior,
          ...(implementation as Record<string, unknown>),
        },
      });
      handle = adapter();
    },
    forwardConnect: (forward) => {
      connect = forward;
    },
    get connect() {
      return connect;
    },
    close: async () => {
      io.disconnectSockets(true);
      await new Promise<void>((done) => io.close(() => done()));

      for (const session of sessions) {
        session.destroy();
      }

      await new Promise<void>((done) =>
        http2.close(() => {
          done();
        }),
      );
      await new Promise<void>((done) => {
        listener.close(() => done());
      });
    },
  };
};

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <title>Doric</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/platform/shell@1.0.0/bootstrap.js"></script>
  </body>
</html>
`;

/** A shell root with `shell.html` and desktop/client's bootstrap bundled. */
const fixtureShell = async (directory: string): Promise<string> => {
  const { build } = await import('esbuild');
  const root = join(directory, 'shell');

  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'shell.html'), SHELL);
  await build({
    entryPoints: [
      resolve('app/desktop/doric-e2e/tests/fixtures/shell-bootstrap.mjs'),
    ],
    outfile: join(root, 'bootstrap.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });

  return root;
};

export interface Notified {
  readonly title: string;
  readonly body: string;
}

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
}

export interface Booted {
  readonly platform: DesktopPlatform;
  /** Every platform log record. */
  readonly logs: LogEntry[];
  readonly host: FakeHost;
  readonly userData: string;
  readonly notified: Notified[];
  /** Every URL main asked the system browser to open; none is opened. */
  readonly opened: string[];
  /** Waits until a window of this key is open and its shell called ready(). */
  window(key: string, timeoutMs?: number): Promise<BrowserWindow>;
  dispose(): Promise<void>;
}

export const until = async <T>(
  probe: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> => {
  const started = Date.now();

  for (;;) {
    const value = await probe();

    if (value !== undefined && value !== false) {
      return value;
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await new Promise((done) => setTimeout(done, 50));
  }
};

/** Evaluates in a window's page; the page is the renderer boundary. */
export const page = <T>(contents: WebContents, script: string): Promise<T> =>
  contents.executeJavaScript(script) as Promise<T>;

/** A platform log that records (and prints with DORIC_TEST_LOG). */
const recording = (logs: LogEntry[]): PlatformLog => {
  const printed =
    process.env.DORIC_TEST_LOG === undefined ? silentLog : createPlatformLog();
  const at =
    (level: LogEntry['level']) =>
    (fields: Readonly<Record<string, unknown>>, message: string) => {
      logs.push({ level, fields, message });
      printed[level](fields, message);
    };

  return { info: at('info'), warn: at('warn'), error: at('error') };
};

/**
 * The system clock, except that the splash's five-second minimum is already
 * over: every reading after the first is five seconds later. Timers are real
 * (the 30 s readiness deadline keeps its meaning).
 */
const holdlessClock = (): Clock => {
  let first = true;

  return {
    now: () => {
      const now = Date.now();

      if (first) {
        first = false;

        return now;
      }

      return now + 5_000;
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
};

export const bootPlatform = async (input: {
  readonly host: FakeHost;
  readonly argv?: readonly string[];
  readonly flushDeadlineMs?: number;
  readonly userData?: string;
  readonly start?: boolean;
  /**
   * The shell the windows load: a fixture whose bootstrap is
   * desktop/client's (default), or the real built renderer
   * (`nx build doric-renderer`), which also follows the host connection as
   * the app's `main.ts` does.
   */
  readonly shell?: 'fixture' | 'renderer';
  /**
   * Where main forwards the window's Connect calls (`doric:connect`): the
   * harness's Connect fake of the host's contracts (S64 to S66); default
   * the host's `forwardConnect`, else main's HTTP/2 forward to the fake
   * host's URL, which serves none.
   */
  readonly hostForward?: HostForward;
}): Promise<Booted> => {
  const hostForward = input.hostForward ?? input.host.connect;
  const userData =
    input.userData ?? (await mkdtemp(join(tmpdir(), 'doric-electron-')));
  const shellRoot =
    input.shell === 'renderer'
      ? resourcesFor(MAIN_DIR).shellRoot
      : await fixtureShell(userData);
  const notified: Notified[] = [];
  const opened: string[] = [];
  const logs: LogEntry[] = [];
  const notifications: NotificationApi = {
    isSupported: () => true,
    create: (options) => ({
      on: () => undefined,
      show: () => notified.push(options),
    }),
  };
  const platform = new DesktopPlatform({
    mainDir: MAIN_DIR,
    userData,
    host: connectHost({ url: input.host.url }),
    packaged: true,
    argv: input.argv ?? [],
    notifications,
    log: recording(logs),
    resources: { ...resourcesFor(MAIN_DIR), shellRoot },
    preload: PRELOAD,
    clock: holdlessClock(),
    openExternal: async (url) => {
      opened.push(url);
    },
    ...(input.flushDeadlineMs === undefined
      ? {}
      : { flushDeadlineMs: input.flushDeadlineMs }),
    ...(hostForward === undefined ? {} : { hostForward }),
  });

  // What `main.ts` attaches before `prepare()`: a theme change repaints every
  // window's native background (T-4.1.1).
  const repaintBackgrounds = () => {
    const color = platform.tokens.color(
      'window',
      nativeTheme.shouldUseDarkColors,
    );

    for (const window of BrowserWindow.getAllWindows()) {
      window.setBackgroundColor(color);
    }
  };

  nativeTheme.on('updated', repaintBackgrounds);

  await platform.prepare();

  if (process.env.DORIC_TEST_LOG !== undefined) {
    platform.splashStates.subscribe((state) =>
      console.log('splash', JSON.stringify(state)),
    );
  }

  const started = input.start === false ? Promise.resolve() : platform.start();

  void started.catch(() => undefined);

  return {
    platform,
    logs,
    host: input.host,
    userData,
    notified,
    opened,
    window: async (key, timeoutMs) => {
      const entry = await until(
        () => platform.registry.byKey(key),
        `the "${key}" window`,
        timeoutMs,
      );
      const contents = entry.contents;

      await until(
        async () =>
          !contents.isLoading() &&
          // The fixture shell marks its ready(); the real one is loaded once
          // its document is (callers wait for what it draws).
          (input.shell === 'renderer'
            ? (await page<string>(contents, 'document.readyState')) ===
              'complete'
            : (await page<string | undefined>(
                contents,
                'document.body?.dataset.ready',
              )) === 'yes'),
        `the "${key}" window to be ready`,
        timeoutMs,
      );

      return entry.window as BrowserWindow;
    },
    dispose: async () => {
      nativeTheme.off('updated', repaintBackgrounds);
      await platform.dispose();

      // A directory the caller passed is the caller's.
      if (input.userData === undefined) {
        await rm(userData, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    },
  };
};
