import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { NormalizedSandboxNetworkPolicy, SandboxSshAccess } from 'sandbox';

import type {
  ContainerInspect,
  ContainerRef,
  DockerClient,
  DockerConnection,
} from './types/docker.js';
import { packFile } from './utils/tar.js';

export type DockerHostConfig = {
  readonly connection: DockerConnection;
  readonly dropbearPath: string;
  readonly statePath: string;
  readonly platform: NodeJS.Platform;
};

export type DockerHostResources = {
  readonly access?: SandboxSshAccess;
  dispose(): Promise<void>;
};

const protectedCidrs = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

export const preflightDockerHost = async (
  network: NormalizedSandboxNetworkPolicy,
  config: DockerHostConfig,
): Promise<void> => {
  const strategy = firewallStrategy(config.platform);

  if (network.mode !== 'egress') {
    return;
  }

  if (strategy === 'nftables') {
    await preflightLinuxFirewall(config);
  }

  if (network.ssh !== false) {
    await access(config.dropbearPath, constants.X_OK).catch(() => {
      throw new Error(
        `Docker SSH requires pinned Dropbear: ${config.dropbearPath}`,
      );
    });
  }
};

export const configureDockerHost = async (input: {
  readonly client: DockerClient;
  readonly container: ContainerRef;
  readonly inspect: ContainerInspect;
  readonly network: NormalizedSandboxNetworkPolicy;
  readonly config: DockerHostConfig;
}): Promise<DockerHostResources> => {
  const id = input.container.id;
  const directory = join(input.config.statePath, id);

  if (input.network.ssh !== false) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  let table: string | undefined;

  try {
    if (input.inspect.ipAddress === undefined) {
      throw new Error(
        'Docker did not assign the sandbox an inspectable IPv4 address',
      );
    }

    if (
      input.network.mode === 'egress' &&
      firewallStrategy(input.config.platform) === 'nftables'
    ) {
      table = `doric_docker_${id.replaceAll('-', '').slice(0, 12)}`;

      await command(
        'nft',
        ['-f', '-'],
        Buffer.from(
          renderDockerFirewall(table, input.inspect.ipAddress, input.network),
        ),
      );
    }

    const access =
      input.network.ssh === false
        ? undefined
        : await configureSsh(input, directory);
    let disposed = false;

    return {
      access,
      async dispose() {
        if (disposed) {
          return;
        }

        const failures: unknown[] = [];

        if (table !== undefined) {
          await command('nft', ['delete', 'table', 'inet', table])
            .then(() => {
              table = undefined;
            })
            .catch((cause) => failures.push(cause));
        }

        await rm(directory, { recursive: true, force: true }).catch((cause) =>
          failures.push(cause),
        );

        if (failures.length > 0) {
          throw new AggregateError(failures, 'Docker host cleanup failed');
        }

        disposed = true;
      },
    };
  } catch (cause) {
    if (table !== undefined) {
      await command('nft', ['delete', 'table', 'inet', table]).catch(
        () => undefined,
      );
    }

    await rm(directory, { recursive: true, force: true });

    throw cause;
  }
};

const preflightLinuxFirewall = async (
  config: DockerHostConfig,
): Promise<void> => {
  if (config.connection.kind !== 'unix') {
    throw new Error('Docker egress requires a local Linux Docker daemon');
  }

  const [self, init] = await Promise.all([
    stat('/proc/self/ns/net'),
    stat('/proc/1/ns/net'),
  ]);

  if (self.dev !== init.dev || self.ino !== init.ino) {
    throw new Error(
      'Docker egress requires access to the host network namespace',
    );
  }

  await command('nft', ['list', 'ruleset']).catch(() => {
    throw new Error('Docker egress requires nftables CAP_NET_ADMIN access');
  });
};

export const firewallStrategy = (
  platform: NodeJS.Platform,
): 'nftables' | 'docker-desktop' => {
  if (platform === 'linux') {
    return 'nftables';
  }

  if (platform === 'darwin' || platform === 'win32') {
    return 'docker-desktop';
  }

  throw new Error(`Docker egress is unsupported on platform: ${platform}`);
};

const configureSsh = async (
  input: Parameters<typeof configureDockerHost>[0],
  directory: string,
): Promise<SandboxSshAccess> => {
  if (input.network.ssh === false) {
    throw new Error('Docker SSH policy is disabled');
  }

  const user = join(directory, 'user');
  const host = join(directory, 'host');

  await command('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    '',
    '-f',
    user,
  ]);

  await command(input.config.dropbearPath, [
    'dropbearkey',
    '-t',
    'ed25519',
    '-f',
    host,
  ]);

  const hostOutput = await command(input.config.dropbearPath, [
    'dropbearkey',
    '-y',
    '-f',
    host,
  ]);

  const hostPublic = Buffer.from(hostOutput)
    .toString('utf8')
    .split(/\r?\n/u)
    .find((line) => line.startsWith('ssh-ed25519 '));

  if (hostPublic === undefined) {
    throw new Error('Docker Dropbear host key is invalid');
  }

  await writeFile(`${host}.pub`, `${hostPublic}\n`, { mode: 0o600 });

  await chmod(user, 0o600);

  const userPublic = (await readFile(`${user}.pub`, 'utf8')).trim();

  await checkedExec(input.client, input.container, [
    'mkdir',
    '-p',
    '/run/doric-ssh',
    '/root/.ssh',
  ]);

  await Promise.all([
    inject(
      input.client,
      input.container,
      '/run/doric-ssh',
      'dropbearmulti',
      await readFile(input.config.dropbearPath),
    ),
    inject(
      input.client,
      input.container,
      '/run/doric-ssh',
      'host_key',
      await readFile(host),
    ),
    inject(
      input.client,
      input.container,
      '/root/.ssh',
      'authorized_keys',
      Buffer.from(`${userPublic}\n`),
    ),
  ]);

  await checkedExec(input.client, input.container, [
    'chmod',
    '0700',
    '/root/.ssh',
  ]);

  await checkedExec(input.client, input.container, [
    'chmod',
    '0600',
    '/root/.ssh/authorized_keys',
    '/run/doric-ssh/host_key',
  ]);

  await checkedExec(input.client, input.container, [
    'chmod',
    '0755',
    '/run/doric-ssh/dropbearmulti',
  ]);

  await input.client.execDetached(input.container, {
    cmd: [
      '/run/doric-ssh/dropbearmulti',
      'dropbear',
      '-F',
      '-E',
      '-s',
      '-g',
      '-j',
      '-k',
      '-p',
      '22',
      '-r',
      '/run/doric-ssh/host_key',
    ],
    user: 'root',
  });

  const binding = input.inspect.ports['22/tcp']?.[0];

  if (binding === undefined) {
    throw new Error('Docker did not publish the SSH port');
  }

  await waitForPort(binding.hostIp, binding.hostPort);

  const advertised = input.network.ssh.advertisedHost ?? binding.hostIp;
  const keyFields = hostPublic.split(/\s+/u);
  const knownHosts = `${binding.hostPort === 22 ? advertised : `[${advertised}]:${binding.hostPort}`} ${keyFields[0]} ${keyFields[1]}`;

  const fingerprintOutput = await command('ssh-keygen', [
    '-E',
    'sha256',
    '-lf',
    `${host}.pub`,
  ]);

  const fingerprint = Buffer.from(fingerprintOutput)
    .toString('utf8')
    .trim()
    .split(/\s+/u)[1];

  if (fingerprint === undefined) {
    throw new Error('Docker SSH host fingerprint is unavailable');
  }

  return {
    host: advertised,
    port: binding.hostPort,
    username: 'root',
    privateKey: await readFile(user, 'utf8'),
    knownHosts,
    hostKeyFingerprint: fingerprint,
  };
};

const waitForPort = async (host: string, port: number): Promise<void> => {
  const target =
    host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (
      await new Promise<boolean>((resolveConnection) => {
        const socket = createConnection({ host: target, port });

        const done = (connected: boolean) => {
          socket.destroy();

          resolveConnection(connected);
        };

        socket.setTimeout(250, () => done(false));

        socket.once('connect', () => done(true));

        socket.once('error', () => done(false));
      })
    ) {
      return;
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  throw new Error('Docker SSH service did not become ready');
};

export const renderDockerFirewall = (
  table: string,
  address: string,
  policy: NormalizedSandboxNetworkPolicy,
): string => {
  const lines = [
    `table inet ${table} {`,
    ' chain input { type filter hook input priority -10; policy accept;',
    `  ip saddr ${address} ct state established,related accept`,
    `  ip saddr ${address} drop`,
    ' }',
    ' chain forward { type filter hook forward priority -10; policy accept;',
    `  ip daddr ${address} ct state established,related accept`,
  ];

  for (const exception of policy.allowPrivate ?? []) {
    lines.push(
      `  ip saddr ${address} ip daddr ${exception.cidr} ${exception.protocol} dport { ${exception.ports.join(', ')} } accept`,
    );
  }

  for (const cidr of protectedCidrs) {
    lines.push(`  ip saddr ${address} ip daddr ${cidr} drop`);
  }

  for (const dns of policy.dnsServers ?? []) {
    lines.push(`  ip saddr ${address} ip daddr ${dns} udp dport 53 accept`);

    lines.push(`  ip saddr ${address} ip daddr ${dns} tcp dport 53 accept`);
  }

  lines.push(' }', '}');

  return `${lines.join('\n')}\n`;
};

const inject = async (
  client: DockerClient,
  container: ContainerRef,
  path: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> => {
  await client.putArchive(container, { path, archive: packFile(name, bytes) });
};

const checkedExec = async (
  client: DockerClient,
  container: ContainerRef,
  cmd: readonly string[],
): Promise<void> => {
  const result = await client.exec(container, { cmd, user: 'root' });

  if (result.exitCode !== 0) {
    throw new Error('Docker SSH setup command failed');
  }
};

const command = (
  file: string,
  args: readonly string[],
  stdin?: Uint8Array,
): Promise<Uint8Array> =>
  new Promise((resolveCommand, reject) => {
    const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'ignore'] });
    const output: Uint8Array[] = [];

    child.stdout.on('data', (chunk: Uint8Array) => output.push(chunk));

    child.once('error', () =>
      reject(new Error('Docker host capability command could not start')),
    );

    child.once('close', (code) => {
      if (code === 0) {
        resolveCommand(Buffer.concat(output));
      } else {
        reject(new Error('Docker host capability command failed'));
      }
    });

    child.stdin.end(stdin);
  });
