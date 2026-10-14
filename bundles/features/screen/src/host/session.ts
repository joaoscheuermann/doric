// The Project screen sessions: one xpra server per Project sandbox, ensured
// on demand and reached through the loopback relay. Everything here runs in
// a host generation, next to the runtime the lease comes from, so the
// process-local `runtime.lease/v1.withLease` task can hand over the sandbox
// directly.
//
// The session record is recoverable: it lives in a marker file inside the
// sandbox, so a respawned host generation (or a restarted host) finds the
// display, the port and the token of a session it already started instead of
// starting a second one. A live session that the marker names is reused after
// its port answers; anything else is restarted.

import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

import type { Log } from 'bundle/contracts';
import type { Sandbox } from 'sandbox';

import type { ScreenUnavailableReason } from '../contracts/index.js';

/** The marker file that makes a session recoverable across restarts. */
export const SCREEN_MARKER_PATH = '/tmp/doric-screen.json';

/** The xpra daemon's log file inside the sandbox. */
export const SCREEN_LOG_PATH = '/tmp/doric-screen.log';

/** The first display a screen session may use. */
export const SCREEN_DISPLAY_BASE = 100;

/** The in-sandbox ports a screen session may bind, in order. */
export const SCREEN_PORT_CANDIDATES = [14500, 14501, 14502] as const;

/** How long a started session may take to accept connections. */
export const SCREEN_READY_TIMEOUT_MS = 10_000;

/** How long the reuse probe waits for an existing session's port. */
export const SCREEN_PROBE_TIMEOUT_MS = 1_000;

/** One recoverable session record, as the marker file stores it. */
export interface ScreenMarker {
  readonly display: number;
  readonly port: number;
  readonly token: string;
}

/** One live session, with where the relay reaches it. */
export interface ScreenSession extends ScreenMarker {
  readonly host: string;
}

/** A screen that cannot be served, carrying the reason the contract reports. */
export class ScreenSessionError extends Error {
  override readonly name = 'ScreenSessionError';

  constructor(readonly reason: ScreenUnavailableReason) {
    super(`The screen session is unavailable (${reason}).`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const markerOf = (raw: string): ScreenMarker | undefined => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const { display, port, token } = parsed;

  if (
    typeof display !== 'number' ||
    !Number.isInteger(display) ||
    display < 1 ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    typeof token !== 'string' ||
    token.length === 0
  ) {
    return undefined;
  }

  return { display, port, token };
};

/** The displays `xpra list` reports as live, in listing order. */
export const screenDisplays = (output: string): readonly number[] => {
  const displays: number[] = [];

  for (const line of output.split('\n')) {
    const match = /LIVE session at :(\d+)/.exec(line);

    if (match !== null) {
      const display = Number(match[1]);

      if (Number.isInteger(display) && !displays.includes(display)) {
        displays.push(display);
      }
    }
  }

  return displays;
};

/** The lowest free display at or above `base`. */
export const screenDisplay = (
  used: readonly number[],
  base = SCREEN_DISPLAY_BASE,
): number => {
  let display = Math.max(1, Math.trunc(base));

  while (used.includes(display)) {
    display += 1;
  }

  return display;
};

/** The `xpra start` argv that daemonizes the session on `0.0.0.0:port`. */
export const screenStartCommand = (input: {
  readonly display: number;
  readonly port: number;
  readonly logPath?: string;
}): readonly string[] => [
  'xpra',
  'start',
  `:${input.display}`,
  '--html=on',
  `--bind-tcp=0.0.0.0:${input.port}`,
  '--daemon=yes',
  `--log-file=${input.logPath ?? SCREEN_LOG_PATH}`,
];

/** The last bytes of a text, enough to read a startup failure. */
export const tailOf = (text: string, limit = 4_096): string =>
  text.length <= limit ? text : text.slice(text.length - limit);

/** Whether a failed start's log names an address already in use. */
export const screenPortTaken = (log: string): boolean =>
  /Address already in use/.test(log) || /failed to setup tcp socket/.test(log);

/** The first routable IPv4 address a sandbox reports. */
export const screenHost = (output: string): string | undefined =>
  output
    .trim()
    .split(/\s+/)
    .find(
      (value) =>
        /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && !value.startsWith('127.'),
    );

export interface ScreenSessionsOptions {
  readonly log: () => Log;
  /** Milliseconds since the epoch; injectable for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Whether an upstream answers; injectable so tests need no sockets. */
  readonly portOpen?: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<boolean>;
}

/** The session manager behind `screen.sessions/v1.attach`. */
export interface ScreenSessionManager {
  /**
   * Ensures the Project's session on the given lease and answers the record
   * the relay exposes. Throws `ScreenSessionError` when the sandbox image
   * has no xpra or the session cannot be started.
   */
  ensure(sandbox: Sandbox): Promise<ScreenSession>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** Whether `host:port` accepts a TCP connection within `timeoutMs`. */
export const portOpen = (
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(timeoutMs, () => settle(false));
  });

export const createScreenSessionManager = (
  options: ScreenSessionsOptions,
): ScreenSessionManager => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const probe = options.portOpen ?? portOpen;
  const hosts = new Map<string, string>();

  const exec = async (
    sandbox: Sandbox,
    cmd: readonly string[],
    timeoutMs = 30_000,
  ) => {
    const result = await sandbox.exec({ cmd, timeoutMs });

    return result;
  };

  /**
   * The marker and the daemon's log live in the sandbox's `/tmp`, which
   * `sandbox.readFile` and `sandbox.writeFile` refuse: both keep every path
   * under the workspace root. Control files are therefore read and written
   * through the sandbox shell, the content travelling as an argument so no
   * value is interpolated into the command text.
   */
  const readControlFile = async (
    sandbox: Sandbox,
    path: string,
  ): Promise<string> => {
    const result = await exec(sandbox, ['cat', path], 10_000).catch(
      () => undefined,
    );

    return result?.exitCode === 0 ? result.stdout : '';
  };

  const writeControlFile = async (
    sandbox: Sandbox,
    path: string,
    content: string,
  ): Promise<void> => {
    await exec(
      sandbox,
      ['sh', '-c', 'printf %s "$1" > "$2"', 'sh', content, path],
      10_000,
    );
  };

  const readMarker = async (
    sandbox: Sandbox,
  ): Promise<ScreenMarker | undefined> =>
    markerOf(await readControlFile(sandbox, SCREEN_MARKER_PATH));

  const writeMarker = async (
    sandbox: Sandbox,
    marker: ScreenMarker,
  ): Promise<void> => {
    await writeControlFile(sandbox, SCREEN_MARKER_PATH, JSON.stringify(marker));
  };

  const hostOf = async (sandbox: Sandbox): Promise<string> => {
    const cached = hosts.get(sandbox.id);

    if (cached !== undefined) {
      return cached;
    }

    const result = await exec(sandbox, ['hostname', '-I'], 10_000);
    const host = screenHost(result.stdout);

    if (host === undefined) {
      throw new ScreenSessionError('start-failed');
    }

    hosts.set(sandbox.id, host);

    return host;
  };

  const waitForPort = async (
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<boolean> => {
    const started = now();

    for (;;) {
      if (await probe(host, port, Math.min(500, timeoutMs))) {
        return true;
      }

      if (now() - started >= timeoutMs) {
        return false;
      }

      await sleep(250);
    }
  };

  /** The displays `xpra list` reports as live, read through the sandbox shell. */
  const liveDisplays = async (sandbox: Sandbox): Promise<readonly number[]> => {
    const listed = await exec(sandbox, ['xpra', 'list'], 10_000).catch(
      () => undefined,
    );

    return listed === undefined ? [] : screenDisplays(listed.stdout);
  };

  /**
   * Whether the display this start asked for is the one that came up. A port
   * that answers is not proof on its own: another session's server may hold
   * the address while `xpra start` failed to bind it, which would otherwise
   * settle a session the relay cannot reach as the one that started.
   */
  const waitForDisplay = async (
    sandbox: Sandbox,
    display: number,
    timeoutMs: number,
  ): Promise<boolean> => {
    const started = now();

    for (;;) {
      if ((await liveDisplays(sandbox)).includes(display)) {
        return true;
      }

      if (now() - started >= timeoutMs) {
        return false;
      }

      await sleep(250);
    }
  };

  const start = async (
    sandbox: Sandbox,
    input: {
      readonly display: number;
      readonly ports: readonly number[];
    },
  ): Promise<Omit<ScreenSession, 'token'>> => {
    const host = await hostOf(sandbox);

    for (const [index, port] of input.ports.entries()) {
      await exec(
        sandbox,
        screenStartCommand({ display: input.display, port }),
        30_000,
      );

      const ready =
        (await waitForDisplay(
          sandbox,
          input.display,
          SCREEN_READY_TIMEOUT_MS,
        )) && (await waitForPort(host, port, SCREEN_READY_TIMEOUT_MS));

      if (ready) {
        return { display: input.display, port, host };
      }

      const log = await readControlFile(sandbox, SCREEN_LOG_PATH);
      const last = input.ports.length - 1;

      if (index === last || !screenPortTaken(tailOf(log))) {
        break;
      }

      options.log().warn('Screen port is taken', {
        display: input.display,
        port,
      });
    }

    throw new ScreenSessionError('start-failed');
  };

  return {
    ensure: async (sandbox) => {
      const xpra = await exec(sandbox, ['sh', '-c', 'command -v xpra'], 10_000);

      if (xpra.exitCode !== 0) {
        throw new ScreenSessionError('missing-xpra');
      }

      const marker = await readMarker(sandbox);
      const listed = await exec(sandbox, ['xpra', 'list'], 10_000);
      const displays = screenDisplays(listed.stdout);
      const host = await hostOf(sandbox);

      if (
        marker !== undefined &&
        displays.includes(marker.display) &&
        (await probe(host, marker.port, SCREEN_PROBE_TIMEOUT_MS))
      ) {
        return { ...marker, host };
      }

      if (marker !== undefined && displays.includes(marker.display)) {
        // The marker's own session no longer listens: stop it so the display
        // is free for the restart.
        await exec(
          sandbox,
          ['xpra', 'stop', `:${marker.display}`],
          10_000,
        ).catch(() => undefined);
      }

      const display =
        marker !== undefined ? marker.display : screenDisplay(displays);
      const ports =
        marker === undefined
          ? SCREEN_PORT_CANDIDATES
          : [
              marker.port,
              ...SCREEN_PORT_CANDIDATES.filter((port) => port !== marker.port),
            ];
      const started = await start(sandbox, { display, ports });
      // A restart of the same Project's session keeps its token, so a panel
      // that was open across the restart reconnects to the same URL.
      const token = marker?.token ?? randomUUID();

      // A lost marker only costs reuse after a restart, but silence here once
      // hid a sandbox that refused the path.
      await writeMarker(sandbox, {
        display: started.display,
        port: started.port,
        token,
      }).catch((error: unknown) => {
        options.log().warn('The screen marker could not be written', {
          display: started.display,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return { ...started, token };
    },
  };
};
