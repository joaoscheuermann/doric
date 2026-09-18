import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NormalizedSandboxNetworkPolicy } from 'sandbox';

import { run } from './command.js';
import type { FirecrackerConfig } from './types.js';

export type VmNetwork = {
  readonly tap: string;
  readonly host: string;
  readonly guest: string;
  readonly guestCidr: string;
  readonly mac: string;
  readonly table: string;
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

/** Allocates a /30, configures its TAP, and installs sandbox-owned nftables rules. */
export const createVmNetwork = async (
  id: string,
  policy: NormalizedSandboxNetworkPolicy,
  config: FirecrackerConfig,
  signal?: AbortSignal,
): Promise<VmNetwork> => {
  const allocation = await allocate(id, config, signal);
  const tap = `doric${id.replaceAll('-', '').slice(0, 10)}`;
  const table = `doric_${id.replaceAll('-', '').slice(0, 12)}`;
  let tapCreated = false;
  let rulesCreated = false;

  try {
    await run({
      file: 'ip',
      args: ['tuntap', 'add', 'dev', tap, 'mode', 'tap'],
      signal,
    });

    tapCreated = true;

    await run({
      file: 'ip',
      args: ['addr', 'add', `${allocation.host}/30`, 'dev', tap],
      signal,
    });

    await run({ file: 'ip', args: ['link', 'set', tap, 'up'], signal });

    await run({
      file: 'nft',
      args: ['-f', '-'],
      stdin: Buffer.from(renderFirecrackerNetworkRules(table, tap, policy)),
      signal,
    });

    rulesCreated = true;

    let disposed = false;

    return {
      ...allocation,
      tap,
      table,
      async dispose() {
        if (disposed) {
          return;
        }

        const failures: unknown[] = [];

        if (rulesCreated) {
          await removeRules(table)
            .then(() => {
              rulesCreated = false;
            })
            .catch((cause) => failures.push(cause));
        }

        if (tapCreated) {
          await run({ file: 'ip', args: ['link', 'delete', tap] })
            .then(() => {
              tapCreated = false;
            })
            .catch((cause) => failures.push(cause));
        }

        await allocation.release().catch((cause) => failures.push(cause));

        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Firecracker network cleanup failed',
          );
        }

        disposed = true;
      },
    };
  } catch (cause) {
    if (rulesCreated) {
      await removeRules(table).catch(() => undefined);
    }

    if (tapCreated) {
      await run({ file: 'ip', args: ['link', 'delete', tap] }).catch(
        () => undefined,
      );
    }

    await allocation.release().catch(() => undefined);

    throw cause;
  }
};

export const renderFirecrackerNetworkRules = (
  table: string,
  tap: string,
  policy: NormalizedSandboxNetworkPolicy,
): string => {
  const lines = [
    `table inet ${table} {`,
    ' chain input { type filter hook input priority 0; policy accept;',
    `  iifname "${tap}" ct state established,related accept`,
    `  iifname "${tap}" drop`,
    ' }',
    ' chain forward { type filter hook forward priority 0; policy accept;',
    `  oifname "${tap}" ct state established,related accept`,
  ];

  if (policy.mode === 'disabled') {
    lines.push(`  iifname "${tap}" drop`);
  } else {
    for (const exception of policy.allowPrivate ?? []) {
      const ports = exception.ports.join(', ');

      lines.push(
        `  iifname "${tap}" ip daddr ${exception.cidr} ${exception.protocol} dport { ${ports} } accept`,
      );
    }

    for (const cidr of protectedCidrs) {
      lines.push(`  iifname "${tap}" ip daddr ${cidr} drop`);
    }

    for (const dns of policy.dnsServers ?? []) {
      lines.push(`  iifname "${tap}" ip daddr ${dns} udp dport 53 accept`);

      lines.push(`  iifname "${tap}" ip daddr ${dns} tcp dport 53 accept`);
    }

    lines.push(`  iifname "${tap}" accept`);
  }

  lines.push(' }', '}');

  if (policy.mode === 'egress') {
    lines.push(
      `table ip ${table}_nat {`,
      ' chain postrouting { type nat hook postrouting priority srcnat; policy accept;',
      `  iifname "${tap}" masquerade`,
      ' }',
      '}',
    );
  }

  return `${lines.join('\n')}\n`;
};

const removeRules = async (table: string): Promise<void> => {
  await run({ file: 'nft', args: ['delete', 'table', 'inet', table] });

  await run({
    file: 'nft',
    args: ['delete', 'table', 'ip', `${table}_nat`],
  }).catch(() => undefined);
};

type Allocation = {
  readonly host: string;
  readonly guest: string;
  readonly guestCidr: string;
  readonly mac: string;
  release(): Promise<void>;
};

const allocate = async (
  id: string,
  config: FirecrackerConfig,
  signal?: AbortSignal,
): Promise<Allocation> => {
  const parsed = pool(config.networkPool);
  const directory = join(config.paths.state, 'networks');

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const unlock = await lock(join(config.paths.state, '.network-lock'), signal);

  try {
    const used = new Set<number>();

    for (const name of await readdir(directory)) {
      const value = Number.parseInt(
        await readFile(join(directory, name), 'utf8'),
        10,
      );

      if (Number.isInteger(value)) {
        used.add(value);
      }
    }

    const count = 2 ** (30 - parsed.prefix);
    let index = 0;

    while (index < count && used.has(index)) {
      index += 1;
    }

    if (index >= count) {
      throw new Error('Firecracker VM network pool is exhausted');
    }

    await writeFile(join(directory, id), String(index), { mode: 0o600 });

    const base = parsed.base + index * 4;

    return {
      host: format(base + 1),
      guest: format(base + 2),
      guestCidr: `${format(base + 2)}/30`,
      mac: `06:fc:${hex(index, 3)}:${hex(index, 2)}:${hex(index, 1)}:${hex(index, 0)}`,
      release: async () => rm(join(directory, id), { force: true }),
    };
  } finally {
    await unlock();
  }
};

const pool = (
  cidr: string,
): { readonly base: number; readonly prefix: number } => {
  const [address, rawPrefix] = cidr.split('/');
  const octets = address?.split('.').map(Number);
  const prefix = Number(rawPrefix);

  if (
    octets?.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    !Number.isInteger(prefix) ||
    prefix < 16 ||
    prefix > 30
  ) {
    throw new Error(
      'Firecracker networkPool must be an IPv4 /16 through /30 CIDR',
    );
  }

  const value = octets.reduce((total, part) => total * 256 + part, 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;

  if ((value & mask) !== value) {
    throw new Error('Firecracker networkPool must use its network address');
  }

  return { base: value, prefix };
};

const lock = async (
  path: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> => {
  for (;;) {
    if (signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });
    }

    try {
      await mkdir(path);

      return async () => rm(path, { recursive: true, force: true });
    } catch (cause) {
      if (!isCode(cause, 'EEXIST')) {
        throw cause;
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
};

const format = (value: number): string =>
  [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');

const hex = (value: number, byte: number): string =>
  ((value >>> (byte * 8)) & 255).toString(16).padStart(2, '0');

const isCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  cause.code === code;
