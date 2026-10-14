import type { Sandbox, SandboxExecInput } from 'sandbox';

import { SCREEN_LOG_PATH } from '../../src/host/session.js';

/** What a fake sandbox holds between commands, as the manager sees it. */
export interface FakeSandboxState {
  readonly files: Map<string, string>;
  readonly displays: Set<number>;
  /** Ports that accept a connection, as the injected probe reads them. */
  readonly ports: Map<number, boolean>;
  readonly commands: string[][];
  /** Whether `command -v xpra` succeeds. */
  xpra: boolean;
  /** The text a failed start leaves in the xpra log file. */
  startLog: string;
  /** Whether one start attempt brings its display and port up. */
  onStart: (display: number, port: number) => boolean;
  readonly hostname: string;
}

const result = (exitCode: number, stdout = '', stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  stdoutBytes: new TextEncoder().encode(stdout),
  stderrBytes: new TextEncoder().encode(stderr),
});

const displayOf = (argv: readonly string[]): number =>
  Number((argv[2] ?? '').replace(/^:/, ''));

const portOf = (argv: readonly string[]): number => {
  const match = /--bind-tcp=0\.0\.0\.0:(\d+)/.exec(argv.join(' '));

  return match === null ? 0 : Number(match[1]);
};

/**
 * A sandbox that answers the manager's commands: `command -v xpra`,
 * `xpra list`, `xpra start`, `xpra stop` and `hostname -I`, over files it
 * keeps in memory.
 */
export const fakeSandbox = (input: Partial<FakeSandboxState> = {}) => {
  const state: FakeSandboxState = {
    files: new Map(),
    displays: new Set(),
    ports: new Map(),
    commands: [],
    xpra: true,
    startLog: '',
    onStart: () => true,
    hostname: '172.17.0.2 \n',
    ...input,
  };
  const root = '/workspace';

  /**
   * The sandbox package keeps every `readFile`/`writeFile` path under the
   * workspace root and refuses the rest. The fake refuses them too, so a
   * control file the manager routed through that API instead of the shell
   * fails here rather than passing on a fake that accepted any path.
   */
  const confined = (path: string): void => {
    if (!path.startsWith(`${root}/`)) {
      throw new Error(`Sandbox paths must stay under ${root}: ${path}`);
    }
  };

  const exec = async ({ cmd }: SandboxExecInput) => {
    state.commands.push([...cmd]);

    if (cmd[0] === 'sh' && cmd[1] === '-c' && cmd[2] === 'command -v xpra') {
      return state.xpra ? result(0, '/usr/bin/xpra\n') : result(1);
    }

    // The marker and the daemon log live outside the workspace root, so the
    // manager reads them with `cat` and writes the marker with `printf`.
    if (cmd[0] === 'cat' && cmd.length === 2) {
      const value = state.files.get(cmd[1] ?? '');

      return value === undefined ? result(1) : result(0, value);
    }

    if (
      cmd[0] === 'sh' &&
      cmd[1] === '-c' &&
      cmd[2] === 'printf %s "$1" > "$2"' &&
      cmd.length === 6
    ) {
      state.files.set(cmd[5] ?? '', cmd[4] ?? '');

      return result(0);
    }

    if (cmd[0] === 'xpra' && cmd[1] === 'list') {
      return result(
        0,
        [...state.displays]
          .sort((left, right) => left - right)
          .map((display) => `LIVE session at :${display}`)
          .join('\n'),
      );
    }

    if (cmd[0] === 'xpra' && cmd[1] === 'stop') {
      state.displays.delete(displayOf(cmd));

      return result(0);
    }

    if (cmd[0] === 'xpra' && cmd[1] === 'start') {
      const display = displayOf(cmd);
      const port = portOf(cmd);
      const up = state.onStart(display, port);

      state.ports.set(port, up);

      if (up) {
        state.displays.add(display);
      } else {
        state.files.set(SCREEN_LOG_PATH, state.startLog);
      }

      return result(0);
    }

    if (cmd[0] === 'hostname') {
      return result(0, state.hostname);
    }

    return result(0);
  };

  const sandbox = {
    id: 'sandbox-1',
    root,
    exec,
    readFile: async (path: string) => {
      confined(path);

      const value = state.files.get(path);

      if (value === undefined) {
        throw new Error(`No such file: ${path}`);
      }

      return value;
    },
    writeFile: async (path: string, content: string) => {
      confined(path);

      state.files.set(path, content);
    },
  } as unknown as Sandbox;

  return { sandbox, state };
};

/** The manager's readiness probe over the fake's port table. */
export const fakeProbe =
  (state: FakeSandboxState) =>
  async (_host: string, port: number, _timeoutMs: number): Promise<boolean> =>
    state.ports.get(port) === true;
