// A plain-JS installed bundle that provides `sandbox/v1` without Docker: each
// Project gets an in-memory sandbox whose files are kept in a map and in which
// every command answers as a shell answers a command it cannot find (exit 127).
// A Project over it becomes ready and its prompts run, while anything that
// needs a program in the sandbox, such as papercraft's `node` runner, fails.
// The test that enables it copies `schemas/` from the staged `docker` bundle.
import { defineMethod, defineService } from 'bundle/contracts';
import { SandboxV1, sandboxMethods } from 'runtime/contracts';

const root = '/workspace';
const empty = new Uint8Array();

const notFound = ({ cmd }) => {
  const stderr = `sh: ${cmd[0] ?? ''}: not found\n`;
  return {
    exitCode: 127,
    stdout: '',
    stderr,
    stdoutBytes: empty,
    stderrBytes: new TextEncoder().encode(stderr),
  };
};

const sandboxFor = (identity) => {
  const files = new Map();
  const read = (path) => {
    const bytes = files.get(path);
    if (bytes === undefined) throw new Error(`No such file: ${path}`);
    return bytes;
  };

  return {
    id: `nodeless-${identity}`,
    root,
    exec: async (input) => notFound(input),
    cloneRepo: async () => {
      throw new Error('This sandbox cannot clone a repository.');
    },
    readFile: async (path) => new TextDecoder().decode(read(path)),
    writeFile: async (path, content) => {
      files.set(path, new TextEncoder().encode(content));
    },
    putFile: async (path, bytes) => {
      files.set(path, new Uint8Array(bytes));
    },
    getFile: async (path) => read(path),
    diff: async () => '',
    ssh: async () => undefined,
  };
};

export const activate = ({ services }) => {
  const machines = new Map();

  services.provide(
    defineService(SandboxV1, {
      describe: defineMethod({
        ...sandboxMethods.describe,
        execute: async () => ({
          provider: 'nodeless-sandbox',
          durableWorkspace: false,
        }),
      }),
      acquire: defineMethod({
        ...sandboxMethods.acquire,
        execute: async ({ identity }) => {
          const sandbox = sandboxFor(identity);
          machines.set(sandbox.id, {
            id: sandbox.id,
            provider: 'nodeless-sandbox',
          });
          return {
            sandbox,
            release: async () => {
              machines.delete(sandbox.id);
            },
          };
        },
      }),
      discard: defineMethod({
        ...sandboxMethods.discard,
        execute: async () => undefined,
      }),
      machines: defineMethod({
        ...sandboxMethods.machines,
        execute: async () => [...machines.values()],
      }),
      machine: defineMethod({
        ...sandboxMethods.machine,
        execute: async (id) => machines.get(id),
      }),
    }),
  );
};
