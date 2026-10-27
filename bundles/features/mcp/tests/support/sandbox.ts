// A fake Project sandbox whose `start` launches an in-process SDK MCP server
// speaking newline-delimited JSON-RPC: what the bundle writes to the process
// reaches the server, and what the server sends comes back as stdout output.
// No host process is ever spawned.

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type {
  Sandbox,
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessInput,
} from 'sandbox';

import { type ToolServer, textTool, toolServer } from './mcp-server.js';
import { deferred } from './wait.js';

/** One process the bundle started in the sandbox. */
export interface StartedProcess {
  readonly input: SandboxProcessInput;
  /** Whether the bundle terminated it. */
  readonly terminated: boolean;
  /** Ends the process on its own, after writing `stderr`. */
  exit(exitCode: number, stderr?: string): Promise<void>;
}

export interface FakeSandbox {
  readonly sandbox: Sandbox;
  readonly started: readonly StartedProcess[];
}

export interface FakeSandboxOptions {
  /** Whether the sandbox offers `start` (true by default). */
  readonly start?: boolean;
  /** The tool server a started process runs; one `echo` tool by default. */
  readonly serverFor?: (input: SandboxProcessInput) => ToolServer;
}

const resultOf = (exitCode: number | null, stderr = ''): SandboxExecResult => ({
  exitCode,
  stdout: '',
  stderr,
  stdoutBytes: new Uint8Array(),
  stderrBytes: new TextEncoder().encode(stderr),
});

const unused = (): never => {
  throw new Error('The MCP bundle has no reason to call this sandbox method.');
};

const launch = async (
  input: SandboxProcessInput,
  server: ToolServer,
): Promise<{ process: SandboxProcess; started: StartedProcess }> => {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const result = deferred<SandboxExecResult>();
  let terminated = false;
  let ended = false;
  let pending = '';

  const end = async (value: SandboxExecResult): Promise<void> => {
    if (ended) {
      return;
    }

    ended = true;
    await client.close();
    result.resolve(value);
  };

  client.onmessage = (message: JSONRPCMessage) => {
    if (!ended) {
      input.onOutput?.({
        stream: 'stdout',
        data: `${JSON.stringify(message)}\n`,
      });
    }
  };

  await server.connect(serverSide);
  await client.start();

  const process: SandboxProcess = {
    result: result.promise,
    write: async (data) => {
      if (ended) {
        throw new Error('The process has ended.');
      }

      pending += data;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim() !== '') {
          await client.send(JSON.parse(line) as JSONRPCMessage);
        }
      }
    },
    resize: async () => undefined,
    terminate: async () => {
      terminated = true;
      await end(resultOf(null));
    },
  };

  return {
    process,
    started: {
      input,
      get terminated() {
        return terminated;
      },
      exit: async (exitCode, stderr = '') => {
        if (stderr !== '') {
          input.onOutput?.({ stream: 'stderr', data: stderr });
        }

        await end(resultOf(exitCode, stderr));
      },
    },
  };
};

export const fakeSandbox = (options: FakeSandboxOptions = {}): FakeSandbox => {
  const started: StartedProcess[] = [];
  const shared = toolServer([textTool('echo')]);
  const serverFor = options.serverFor ?? (() => shared);

  const base = {
    id: 'sandbox-1',
    root: '/workspace',
    exec: unused,
    cloneRepo: unused,
    readFile: unused,
    writeFile: unused,
    putFile: unused,
    getFile: unused,
    diff: unused,
    ssh: unused,
  };

  const sandbox: Sandbox =
    options.start === false
      ? base
      : {
          ...base,
          start: async (input) => {
            const launched = await launch(input, serverFor(input));
            started.push(launched.started);

            return launched.process;
          },
        };

  return { sandbox, started };
};
