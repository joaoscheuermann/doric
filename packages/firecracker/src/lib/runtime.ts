import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { SandboxProvisionInput, SandboxRuntime } from 'sandbox';

import { createFirecrackerApi } from './api.js';
import { run, start } from './command.js';
import { createWritableDisk } from './disk.js';
import { type PreparedImage, prepareImage } from './image.js';
import { createVmNetwork, type VmNetwork } from './network.js';
import {
  createGuestConnection,
  exposeUserSsh,
  generateSshKeys,
  type GuestConnection,
  waitForGuest,
  writeKnownHosts,
} from './ssh.js';
import type { FirecrackerConfig } from './types.js';

type Resources = {
  readonly id: string;
  readonly directory: string;
  readonly jailDirectory: string;
  readonly jailRoot: string;
  image?: PreparedImage;
  network?: VmNetwork;
  process?: ChildProcess;
  baseMounted: boolean;
  proxy?: Awaited<ReturnType<typeof exposeUserSsh>>;
};

/** Provisions one jailed Firecracker microVM and its management channel. */
export const provisionFirecracker = async (
  input: SandboxProvisionInput,
  config: FirecrackerConfig,
): Promise<SandboxRuntime> => {
  const id = randomUUID();
  const directory = join(config.paths.state, 'sandboxes', id);
  const jailDirectory = join(config.paths.state, 'jailer', 'firecracker', id);
  const jailRoot = join(jailDirectory, 'root');

  const resources: Resources = {
    id,
    directory,
    jailDirectory,
    jailRoot,
    baseMounted: false,
  };

  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    const keysDirectory = join(directory, 'keys');

    await mkdir(keysDirectory, { mode: 0o700 });

    const keys = await generateSshKeys(keysDirectory, config.paths.dropbear);

    resources.image = await prepareImage(
      input.image,
      id,
      config,
      undefined,
      input.imagePullPolicy ?? 'always',
    );

    resources.network = await createVmNetwork(id, input.network, config);

    const writable = await createWritableDisk({
      directory,
      diskMiB: input.resources.diskMiB,
      guestCidr: resources.network.guestCidr,
      gateway: resources.network.host,
      network: input.network,
      keys,
    });

    resources.process = launchJailer(id, config);

    await waitForPath(jailRoot, resources.process, config.readinessTimeoutMs);

    await copyBootArtifacts(config, jailRoot);

    await mountBase(resources.image.disk, join(jailRoot, 'base.ext4'));

    resources.baseMounted = true;

    await rename(writable, join(jailRoot, 'writable.ext4'));

    const socket = join(jailRoot, 'api.socket');

    await waitForPath(socket, resources.process, config.readinessTimeoutMs);

    const api = createFirecrackerApi(socket, config.transport);

    await api.configure({
      cpuCount: input.resources.cpuCount,
      memoryMiB: input.resources.memoryMiB,
      kernel: '/vmlinux',
      initramfs: '/initramfs.cpio',
      baseDisk: '/base.ext4',
      writableDisk: '/writable.ext4',
      tap: resources.network.tap,
      guestMac: resources.network.mac,
    });

    await persist(resources);

    await api.start();

    const knownHosts = join(keysDirectory, 'known_hosts');

    await writeKnownHosts(
      knownHosts,
      resources.network.guest,
      22,
      keys.hostPublic,
    );

    const connection = createGuestConnection({
      host: resources.network.guest,
      privateKeyPath: join(keysDirectory, 'management'),
      knownHostsPath: knownHosts,
      env: resources.image.env,
      user: resources.image.user,
    });

    await waitForGuest(connection, config.readinessTimeoutMs);

    resources.proxy = await exposeUserSsh(
      input.network,
      resources.network.guest,
      keys,
    );

    return runtime(resources, connection);
  } catch (cause) {
    await dispose(resources).catch(() => undefined);

    throw cause;
  }
};

const runtime = (
  resources: Resources,
  connection: GuestConnection,
): SandboxRuntime => {
  let disposed = false;

  return {
    id: resources.id,
    exec: (input) => connection.exec(input),
    putFile: (path, bytes) => connection.putFile(path, bytes),
    getFile: (path) => connection.getFile(path),
    async ssh() {
      return resources.proxy?.access;
    },
    async dispose() {
      if (disposed) {
        return;
      }

      await dispose(resources);

      disposed = true;
    },
  };
};

const launchJailer = (id: string, config: FirecrackerConfig): ChildProcess =>
  start({
    file: config.paths.jailer,
    args: [
      '--id',
      id,
      '--exec-file',
      config.paths.firecracker,
      '--uid',
      String(config.jailerUid),
      '--gid',
      String(config.jailerGid),
      '--chroot-base-dir',
      join(config.paths.state, 'jailer'),
      '--cgroup-version',
      '2',
      '--',
      '--api-sock',
      '/api.socket',
    ],
  });

const copyBootArtifacts = async (
  config: FirecrackerConfig,
  root: string,
): Promise<void> => {
  const kernel = join(root, 'vmlinux');
  const initramfs = join(root, 'initramfs.cpio');

  await copyFile(config.paths.kernel, kernel);

  await copyFile(config.paths.initramfs, initramfs);

  await chmod(kernel, 0o400);

  await chmod(initramfs, 0o400);
};

const mountBase = async (source: string, target: string): Promise<void> => {
  (await open(target, 'w', 0o400)).close();

  await run({ file: 'mount', args: ['--bind', source, target] });

  try {
    await run({ file: 'mount', args: ['-o', 'remount,bind,ro', target] });
  } catch (cause) {
    await run({ file: 'umount', args: [target] }).catch(() => undefined);

    throw cause;
  }
};

const waitForPath = async (
  path: string,
  process: ChildProcess,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error('Firecracker jailer exited before readiness');
    }

    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }

  throw new Error('Firecracker jailer readiness timed out');
};

const persist = async (resources: Resources): Promise<void> => {
  const state = {
    id: resources.id,
    pid: resources.process?.pid,
    tap: resources.network?.tap,
    table: resources.network?.table,
    jailDirectory: resources.jailDirectory,
    baseMounted: resources.baseMounted,
  };

  await writeFile(
    join(resources.directory, 'state.json'),
    JSON.stringify(state),
    {
      mode: 0o600,
    },
  );
};

const dispose = async (resources: Resources): Promise<void> => {
  const failures: unknown[] = [];

  if (resources.proxy?.server !== undefined) {
    await close(resources.proxy.server).catch((cause) => failures.push(cause));
  }

  if (resources.process !== undefined) {
    await terminate(resources.process).catch((cause) => failures.push(cause));
  }

  if (resources.baseMounted) {
    await run({
      file: 'umount',
      args: [join(resources.jailRoot, 'base.ext4')],
    })
      .then(() => {
        resources.baseMounted = false;
      })
      .catch((cause) => failures.push(cause));
  }

  await resources.network?.dispose().catch((cause) => failures.push(cause));

  await rm(resources.jailDirectory, { recursive: true, force: true }).catch(
    (cause) => failures.push(cause),
  );

  await rm(resources.directory, { recursive: true, force: true }).catch(
    (cause) => failures.push(cause),
  );

  await resources.image?.release().catch((cause) => failures.push(cause));

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Firecracker cleanup failed');
  }
};

const terminate = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  const exited = once(child, 'exit');

  const timeout = new Promise<'timeout'>((resolveTimeout) =>
    setTimeout(() => resolveTimeout('timeout'), 2_000),
  );

  if ((await Promise.race([exited, timeout])) === 'timeout') {
    child.kill('SIGKILL');

    await once(child, 'exit');
  }
};

const close = (
  server: NonNullable<Resources['proxy']>['server'],
): Promise<void> =>
  new Promise((resolveClose, reject) => {
    if (server === undefined || !server.listening) {
      resolveClose();

      return;
    }

    server.close((cause) =>
      cause === undefined ? resolveClose() : reject(cause),
    );
  });
