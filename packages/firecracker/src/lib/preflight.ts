import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';

import { run, text } from './command.js';
import type { FirecrackerConfig } from './types.js';

/** Rejects hosts that cannot uphold the Firecracker isolation contract. */
export const preflightFirecrackerHost = async (
  config: FirecrackerConfig,
): Promise<void> => {
  if (process.platform !== 'linux') {
    throw new Error('Firecracker requires a Linux host');
  }

  if (process.arch !== 'x64') {
    throw new Error('Firecracker requires an x86_64 host');
  }

  await Promise.all([
    requireAccess(
      '/dev/kvm',
      constants.R_OK | constants.W_OK,
      'read/write KVM access',
    ),
    requireAccess(
      '/dev/net/tun',
      constants.R_OK | constants.W_OK,
      'read/write TUN access',
    ),
    requireAccess(
      '/sys/fs/cgroup/cgroup.controllers',
      constants.R_OK,
      'cgroup v2',
    ),
    requireAccess(
      config.paths.firecracker,
      constants.X_OK,
      'Firecracker binary',
    ),
    requireAccess(config.paths.jailer, constants.X_OK, 'Firecracker jailer'),
    requireAccess(config.paths.kernel, constants.R_OK, 'guest kernel'),
    requireAccess(config.paths.initramfs, constants.R_OK, 'guest initramfs'),
    requireAccess(config.paths.dropbear, constants.X_OK, 'Dropbear key tool'),
    requireAccess(
      config.paths.state,
      constants.R_OK | constants.W_OK,
      'state directory',
    ),
    requireAccess(
      config.paths.cache,
      constants.R_OK | constants.W_OK,
      'rootfs cache directory',
    ),
    requireNftables(),
    requireIpForwarding(),
    requireVersion(config),
    ...[
      'debugfs',
      'ip',
      'mkfs.ext4',
      'mount',
      'skopeo',
      'ssh',
      'ssh-keygen',
      'truncate',
      'umoci',
      'umount',
    ].map(requireCommand),
  ]);
};

const requireAccess = async (
  path: string,
  mode: number,
  capability: string,
): Promise<void> => {
  try {
    await access(path, mode);
  } catch {
    throw new Error(`Firecracker preflight requires ${capability}: ${path}`);
  }
};

const requireNftables = async (): Promise<void> => {
  const candidates = ['/usr/sbin/nft', '/usr/bin/nft', '/sbin/nft'];

  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);

      await run({ file: path, args: ['list', 'ruleset'] }).catch(() => {
        throw new Error(
          'Firecracker preflight requires nftables CAP_NET_ADMIN access',
        );
      });

      return;
    } catch {
      // Try the next conventional location.
    }
  }

  throw new Error('Firecracker preflight requires the nftables executable');
};

const requireVersion = async (config: FirecrackerConfig): Promise<void> => {
  const [firecracker, jailer] = await Promise.all([
    run({ file: config.paths.firecracker, args: ['--version'] }),
    run({ file: config.paths.jailer, args: ['--version'] }),
  ]);

  if (!text(firecracker.stdout).includes('1.16.1')) {
    throw new Error('Firecracker preflight requires Firecracker v1.16.1');
  }

  if (!text(jailer.stdout).includes('1.16.1')) {
    throw new Error('Firecracker preflight requires jailer v1.16.1');
  }
};

const requireCommand = async (command: string): Promise<void> => {
  const path = ['/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].map(
    (directory) => `${directory}/${command}`,
  );

  for (const candidate of path) {
    try {
      await access(candidate, constants.X_OK);

      return;
    } catch {
      // Try the next fixed system path.
    }
  }

  throw new Error(`Firecracker preflight requires host command: ${command}`);
};

const requireIpForwarding = async (): Promise<void> => {
  const value = await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8').catch(
    () => '0',
  );

  if (value.trim() !== '1') {
    throw new Error('Firecracker preflight requires IPv4 forwarding');
  }
};
