import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NormalizedSandboxNetworkPolicy } from 'sandbox';

import { run } from './command.js';
import type { SshKeys } from './ssh.js';

/** Creates and seeds one sparse ext4 writable overlay disk for a VM. */
export const createWritableDisk = async (input: {
  readonly directory: string;
  readonly diskMiB: number;
  readonly guestCidr: string;
  readonly gateway: string;
  readonly network: NormalizedSandboxNetworkPolicy;
  readonly keys: SshKeys;
  readonly signal?: AbortSignal;
}): Promise<string> => {
  const disk = join(input.directory, 'writable.ext4');
  const seed = join(input.directory, `seed-${randomUUID()}`);

  await mkdir(seed, { recursive: true, mode: 0o700 });

  try {
    await run({
      file: 'truncate',
      args: ['-s', `${input.diskMiB}M`, disk],
      signal: input.signal,
    });

    await run({
      file: 'mkfs.ext4',
      args: ['-F', '-q', disk],
      signal: input.signal,
    });

    const files = {
      authorized_keys: `${input.keys.managementPublic}\n${input.keys.userPublic}\n`,
      dropbear_host_key: input.keys.hostPrivate,
      guest_cidr: `${input.guestCidr}\n`,
      gateway: `${input.gateway}\n`,
      'resolv.conf': (input.network.dnsServers ?? [])
        .map((server) => `nameserver ${server}`)
        .join('\n'),
    } as const;

    await debugfs(disk, 'mkdir /config', input.signal);

    await debugfs(disk, 'mkdir /upper', input.signal);

    await debugfs(disk, 'mkdir /work', input.signal);

    for (const [name, value] of Object.entries(files)) {
      const source = join(seed, name);

      await writeFile(source, value, { mode: 0o600 });

      await debugfs(disk, `write ${source} /config/${name}`, input.signal);
    }

    return disk;
  } catch (cause) {
    await rm(disk, { force: true });

    throw cause;
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
};

const debugfs = async (
  disk: string,
  command: string,
  signal?: AbortSignal,
): Promise<void> => {
  await run({
    file: 'debugfs',
    args: ['-w', '-R', command, disk],
    signal,
  });
};
