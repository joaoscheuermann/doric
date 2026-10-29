// What the Electron tests boot: the real desktop platform over the built
// platform assets, a fake host (a Socket.IO server in this process, the real
// network boundary) and a fixture shell whose bootstrap is desktop/client's.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DRAWIO_ORIGIN } from 'bundle/contracts';
import { type DistributionCatalog, PLATFORM_VERSION } from 'bundle/runtime';
import {
  type BrowserWindow,
  type Session,
  session,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import { Server, type Socket } from 'socket.io';

import { DesktopPlatform } from '../../../doric/src/platform/app';
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

export interface HostCall {
  readonly contract: string;
  readonly method: string;
  readonly input: unknown;
}

export interface FakeHost {
  readonly url: string;
  readonly calls: HostCall[];
  /** Publishes a new distribution and tells every `watch()` subscriber. */
  publish(
    catalog: DistributionCatalog,
    artifacts?: ReadonlyMap<string, Buffer>,
  ): void;
  /** Refuses the next `count` connections (the host is down). */
  refuse(count: number): void;
  /** Answers `contract method` calls with `handler` (other host methods). */
  serve(
    contract: string,
    method: string,
    handler: (input: unknown) => unknown,
  ): void;
  close(): Promise<void>;
}

export const startFakeHost = async (input: {
  readonly catalog: DistributionCatalog;
  readonly artifacts: ReadonlyMap<string, Buffer | string>;
}): Promise<FakeHost> => {
  let catalog = input.catalog;
  const artifacts = new Map<string, Buffer>(
    [...input.artifacts].map(([hash, content]) => [hash, Buffer.from(content)]),
  );
  const calls: HostCall[] = [];
  const watchers = new Map<string, Socket>();
  const handlers = new Map<string, (input: unknown) => unknown>();
  let refusals = 0;
  const http: HttpServer = createServer();
  const io = new Server(http);
  const bridge = io.of('/doric/bridge');

  bridge.use((_socket, next) => {
    if (refusals > 0) {
      refusals -= 1;
      next(new Error('The host is starting.'));

      return;
    }

    next();
  });
  bridge.on('connection', (socket) => {
    socket.on('call', (message: { id: string } & HostCall) => {
      calls.push({
        contract: message.contract,
        method: message.method,
        input: message.input,
      });

      const answer = (output: unknown) =>
        socket.emit('result', {
          kind: 'result',
          id: message.id,
          ok: true,
          output,
        });
      const fail = (code: string, text: string) =>
        socket.emit('result', {
          kind: 'result',
          id: message.id,
          ok: false,
          error: { code, message: text },
        });

      if (
        message.contract === 'doric.catalog/v1' &&
        message.method === 'distribution'
      ) {
        answer(catalog);
      } else if (
        message.contract === 'doric.catalog/v1' &&
        message.method === 'artifact'
      ) {
        const sha256 = (message.input as { sha256: string }).sha256;
        const bytes = artifacts.get(sha256);

        if (bytes === undefined) {
          fail('not_found', `No artifact ${sha256}.`);
        } else {
          answer({ sha256, base64: bytes.toString('base64') });
        }
      } else if (
        message.contract === 'doric.diagnostics/v1' &&
        message.method === 'report'
      ) {
        answer(undefined);
      } else if (handlers.has(`${message.contract} ${message.method}`)) {
        const handler = handlers.get(
          `${message.contract} ${message.method}`,
        ) as (input: unknown) => unknown;

        answer(handler(message.input));
      } else {
        fail(
          'unavailable',
          `${message.contract} ${message.method} is not served.`,
        );
      }
    });
    socket.on('subscribe', (message: { id: string } & HostCall) => {
      calls.push({
        contract: message.contract,
        method: message.method,
        input: message.input,
      });

      if (
        message.contract === 'doric.catalog/v1' &&
        message.method === 'watch'
      ) {
        watchers.set(message.id, socket);
      }
    });
    socket.on('unsubscribe', (message: { id: string }) =>
      watchers.delete(message.id),
    );
  });

  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));

  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    publish: (next, more) => {
      catalog = next;

      for (const [hash, bytes] of more ?? []) {
        artifacts.set(hash, bytes);
      }

      for (const [id, socket] of watchers) {
        socket.emit('event', {
          kind: 'event',
          id,
          values: [{ generation: next.generation }],
        });
      }
    },
    refuse: (count) => {
      refusals = count;
    },
    serve: (contract, method, handler) => {
      handlers.set(`${contract} ${method}`, handler);
    },
    close: async () => {
      io.disconnectSockets(true);
      await new Promise<void>((done) => io.close(() => done()));
    },
  };
};

const SHELL = `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="dark" />
    <title>Doric</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/platform/shell@${PLATFORM_VERSION}/bootstrap.js"></script>
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
}): Promise<Booted> => {
  const userData =
    input.userData ?? (await mkdtemp(join(tmpdir(), 'doric-electron-')));
  const shellRoot = await fixtureShell(userData);
  const notified: Notified[] = [];
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
    hostUrl: input.host.url,
    packaged: true,
    argv: input.argv ?? [],
    notifications,
    log: recording(logs),
    resources: { ...resourcesFor(MAIN_DIR), shellRoot },
    preload: PRELOAD,
    clock: holdlessClock(),
    ...(input.flushDeadlineMs === undefined
      ? {}
      : { flushDeadlineMs: input.flushDeadlineMs }),
  });

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
          (await page<string | undefined>(
            contents,
            'document.body?.dataset.ready',
          )) === 'yes',
        `the "${key}" window to be ready`,
        timeoutMs,
      );

      return entry.window as BrowserWindow;
    },
    dispose: async () => {
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

export interface RecordedRequest {
  readonly url: string;
  readonly resourceType: string;
}

export interface RecordedResponse {
  readonly url: string;
  readonly statusCode: number;
}

export interface RequestLog {
  /** Every request the session started, in order. */
  readonly requests: RecordedRequest[];
  /** Every request that completed, with its status. */
  readonly responses: RecordedResponse[];
  stop(): void;
}

/**
 * Records every request of a session through `webRequest` (the session's
 * only `onBeforeRequest` and `onCompleted` listeners while it records).
 */
export const recordRequests = (
  target: Session = session.defaultSession,
): RequestLog => {
  const requests: RecordedRequest[] = [];
  const responses: RecordedResponse[] = [];

  target.webRequest.onBeforeRequest((details, callback) => {
    requests.push({ url: details.url, resourceType: details.resourceType });
    callback({});
  });
  target.webRequest.onCompleted((details) => {
    responses.push({ url: details.url, statusCode: details.statusCode });
  });

  return {
    requests,
    responses,
    stop: () => {
      target.webRequest.onBeforeRequest(null);
      target.webRequest.onCompleted(null);
    },
  };
};

export interface CspIssue {
  readonly violatedDirective: string;
  /** `kInlineViolation`, `kEvalViolation`, `kURLViolation`, … */
  readonly violationType: string;
  readonly blockedURL?: string;
  readonly isReportOnly: boolean;
}

export interface CspIssueLog {
  readonly issues: CspIssue[];
  stop(): void;
}

interface AuditsIssue {
  readonly code: string;
  readonly details?: {
    readonly contentSecurityPolicyIssueDetails?: {
      readonly violatedDirective: string;
      readonly contentSecurityPolicyViolationType: string;
      readonly blockedURL?: string;
      readonly isReportOnly: boolean;
    };
  };
}

/**
 * The CSP problems Chromium reports for a window and every frame in it, out
 * of process ones included: the CDP `Audits` domain on the window's
 * debugger, auto-attached to each child target.
 */
export const cspIssues = async (
  contents: WebContents,
): Promise<CspIssueLog> => {
  const issues: CspIssue[] = [];
  const debug = contents.debugger;
  const onMessage = (
    _event: unknown,
    method: string,
    params: Record<string, unknown>,
  ) => {
    if (method === 'Target.attachedToTarget') {
      const child = params.sessionId as string;

      void debug
        .sendCommand('Audits.enable', {}, child)
        .then(() =>
          debug.sendCommand(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
            child,
          ),
        )
        .finally(() =>
          debug.sendCommand('Runtime.runIfWaitingForDebugger', {}, child),
        )
        .catch(() => undefined);

      return;
    }

    if (method !== 'Audits.issueAdded') {
      return;
    }

    const issue = params.issue as AuditsIssue;
    const details = issue.details?.contentSecurityPolicyIssueDetails;

    if (issue.code === 'ContentSecurityPolicyIssue' && details !== undefined) {
      issues.push({
        violatedDirective: details.violatedDirective,
        violationType: details.contentSecurityPolicyViolationType,
        ...(details.blockedURL === undefined
          ? {}
          : { blockedURL: details.blockedURL }),
        isReportOnly: details.isReportOnly,
      });
    }
  };

  if (!debug.isAttached()) {
    debug.attach('1.3');
  }

  debug.on('message', onMessage);
  await debug.sendCommand('Audits.enable');
  await debug.sendCommand('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  return {
    issues,
    stop: () => {
      debug.off('message', onMessage);

      if (debug.isAttached()) {
        debug.detach();
      }
    },
  };
};

/** The frame of a window at the draw.io editor origin, by its iframe name. */
export const editorFrame = (
  contents: WebContents,
  name?: string,
): WebFrameMain | undefined =>
  contents.mainFrame.framesInSubtree.find(
    (frame) =>
      frame !== contents.mainFrame &&
      (frame.url === DRAWIO_ORIGIN ||
        frame.url.startsWith(`${DRAWIO_ORIGIN}/`)) &&
      (name === undefined || frame.name === name),
  );
