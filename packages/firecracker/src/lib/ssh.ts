import { spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';

import type {
  NormalizedSandboxNetworkPolicy,
  SandboxExecInput,
  SandboxExecResult,
  SandboxSshAccess,
} from 'sandbox';

import { run, text } from './command.js';

export type SshKeys = {
  readonly managementPrivate: string;
  readonly managementPublic: string;
  readonly userPrivate: string;
  readonly userPublic: string;
  readonly hostPrivate: Uint8Array;
  readonly hostPublic: string;
  readonly fingerprint: string;
};

export type GuestConnection = {
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;

  putFile(path: string, bytes: Uint8Array): Promise<void>;

  getFile(path: string): Promise<Uint8Array>;
};

export const generateSshKeys = async (
  directory: string,
  dropbear: string,
): Promise<SshKeys> => {
  const management = join(directory, 'management');
  const user = join(directory, 'user');
  const host = join(directory, 'host');

  await Promise.all([key(management), key(user)]);

  await run({
    file: dropbear,
    args: ['dropbearkey', '-t', 'ed25519', '-f', host],
  });

  const hostPublicOutput = text(
    (await run({ file: dropbear, args: ['dropbearkey', '-y', '-f', host] }))
      .stdout,
  );

  const publicLine = hostPublicOutput
    .split(/\r?\n/u)
    .find((line) => line.startsWith('ssh-ed25519 '));

  if (publicLine === undefined) {
    throw new Error('Could not derive Firecracker SSH host public key');
  }

  await writeFile(`${host}.pub`, `${publicLine}\n`, { mode: 0o600 });

  const [
    managementPrivate,
    managementPublic,
    userPrivate,
    userPublic,
    hostPrivate,
    hostPublic,
  ] = await Promise.all([
    readFile(management, 'utf8'),
    readFile(`${management}.pub`, 'utf8'),
    readFile(user, 'utf8'),
    readFile(`${user}.pub`, 'utf8'),
    readFile(host),
    readFile(`${host}.pub`, 'utf8'),
  ]);

  const fingerprint = text(
    (
      await run({
        file: 'ssh-keygen',
        args: ['-E', 'sha256', '-lf', `${host}.pub`],
      })
    ).stdout,
  )
    .trim()
    .split(/\s+/u)[1];

  if (fingerprint === undefined) {
    throw new Error('Could not fingerprint Firecracker SSH host key');
  }

  return {
    managementPrivate,
    managementPublic: managementPublic.trim(),
    userPrivate,
    userPublic: userPublic.trim(),
    hostPrivate,
    hostPublic: hostPublic.trim(),
    fingerprint,
  };
};

export const writeKnownHosts = async (
  path: string,
  host: string,
  port: number,
  publicKey: string,
): Promise<string> => {
  const line = knownHost(host, port, publicKey);

  await writeFile(path, `${line}\n`, { mode: 0o600 });

  return line;
};

export const createGuestConnection = (input: {
  readonly host: string;
  readonly privateKeyPath: string;
  readonly knownHostsPath: string;
  readonly env: readonly string[];
  readonly user: string;
}): GuestConnection => ({
  exec: (request) => execute(input, request),
  putFile: async (path, bytes) => {
    const result = await invoke(
      input,
      `/.doric/bin/busybox cat > ${quote(path)}`,
      bytes,
      undefined,
      undefined,
      false,
    );

    if (result.exitCode !== 0) {
      throw new Error('Firecracker file upload failed');
    }
  },
  async getFile(path) {
    const result = await invoke(
      input,
      `/.doric/bin/busybox cat ${quote(path)}`,
      undefined,
      undefined,
      undefined,
      false,
    );

    if (result.exitCode !== 0) {
      throw new Error('Firecracker file download failed');
    }

    return result.stdoutBytes;
  },
});

export const waitForGuest = async (
  connection: GuestConnection,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });
    }

    try {
      const result = await connection.exec({
        cmd: ['true'],
        timeoutMs: 1_000,
        signal,
      });

      if (result.exitCode === 0) {
        return;
      }
    } catch {
      // The API socket can be ready before the guest network and Dropbear.
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  throw new Error('Firecracker guest readiness timed out');
};

export const exposeUserSsh = async (
  policy: NormalizedSandboxNetworkPolicy,
  guest: string,
  keys: SshKeys,
): Promise<{
  readonly access?: SandboxSshAccess;
  readonly server?: Server;
}> => {
  if (policy.ssh === false) {
    return {};
  }

  const ssh = policy.ssh;

  const server = createServer((client) => {
    const upstream = createConnection({ host: guest, port: 22 });

    client.pipe(upstream).pipe(client);

    const close = () => {
      client.destroy();

      upstream.destroy();
    };

    client.once('error', close);

    upstream.once('error', close);
  });

  const address = await new Promise<{
    readonly address: string;
    readonly port: number;
  }>((resolveListen, reject) => {
    server.once('error', reject);

    server.listen(ssh.port ?? 0, ssh.bindAddress, () => {
      server.removeListener('error', reject);

      const value = server.address();

      if (value === null || typeof value === 'string') {
        reject(new Error('Firecracker SSH proxy did not expose a TCP address'));

        return;
      }

      resolveListen({ address: value.address, port: value.port });
    });
  });
  const host = ssh.advertisedHost ?? address.address;

  return {
    server,
    access: {
      host,
      port: address.port,
      username: 'root',
      privateKey: keys.userPrivate,
      knownHosts: knownHost(host, address.port, keys.hostPublic),
      hostKeyFingerprint: keys.fingerprint,
    },
  };
};

const execute = async (
  connection: Parameters<typeof createGuestConnection>[0],
  input: SandboxExecInput,
): Promise<SandboxExecResult> => {
  if (input.cmd.length === 0) {
    throw new Error('Sandbox command must not be empty');
  }

  const env = mergeEnv(connection.env, input.env ?? []);
  const command = input.cmd.map(quote).join(' ');
  const script = `cd ${quote(input.cwd ?? '/workspace')} && /.doric/bin/busybox env ${env.map(quote).join(' ')} ${command}`;
  const user = input.user ?? connection.user;

  const remote = root(user)
    ? script
    : `/.doric/bin/busybox su -s /.doric/bin/sh ${quote(user.split(':')[0] ?? user)} -c ${quote(script)}`;

  return invoke(
    connection,
    remote,
    undefined,
    input.signal,
    input.timeoutMs,
    input.tty === true,
  );
};

const invoke = (
  connection: Parameters<typeof createGuestConnection>[0],
  remote: string,
  stdin: Uint8Array | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  tty: boolean,
): Promise<SandboxExecResult> =>
  new Promise((resolveInvoke, reject) => {
    const args = [
      '-T',
      '-i',
      connection.privateKeyPath,
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${connection.knownHostsPath}`,
      '-o',
      'ConnectTimeout=2',
      `root@${connection.host}`,
      remote,
    ];

    if (tty) {
      args[0] = '-tt';
    }

    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let timedOut = false;
    const abort = () => child.kill('SIGKILL');

    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;

            abort();
          }, timeoutMs);

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      signal?.removeEventListener('abort', abort);
    };

    child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));

    child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));

    child.once('error', () => {
      cleanup();

      reject(new Error('Firecracker management SSH could not start'));
    });

    child.once('close', (code) => {
      cleanup();

      if (timedOut) {
        reject(new Error('Sandbox command timed out'));

        return;
      }

      if (signal?.aborted) {
        reject(
          Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
          }),
        );

        return;
      }

      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);

      resolveInvoke({
        exitCode: code,
        stdout: out.toString('utf8'),
        stderr: err.toString('utf8'),
        stdoutBytes: out,
        stderrBytes: err,
      });
    });

    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }

    child.stdin.end(stdin);
  });

const key = async (path: string): Promise<void> => {
  await run({
    file: 'ssh-keygen',
    args: ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', path],
  });

  await chmod(path, 0o600);
};

const knownHost = (host: string, port: number, publicKey: string): string => {
  const fields = publicKey.trim().split(/\s+/u);

  if (fields.length < 2) {
    throw new Error('Firecracker SSH public host key is invalid');
  }

  const target = port === 22 ? host : `[${host}]:${port}`;

  return `${target} ${fields[0]} ${fields[1]}`;
};

const mergeEnv = (
  base: readonly string[],
  overrides: readonly string[],
): readonly string[] => {
  const values = new Map<string, string>();

  for (const item of [...base, ...overrides]) {
    const index = item.indexOf('=');

    if (index > 0) {
      values.set(item.slice(0, index), item);
    }
  }

  return [...values.values()];
};

const root = (user: string): boolean =>
  user === '' || user === 'root' || user === '0' || user === '0:0';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
