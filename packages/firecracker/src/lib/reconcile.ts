import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { run } from './command.js';
import type { FirecrackerConfig } from './types.js';

type StaleState = {
  readonly pid?: unknown;
};

/** Removes resources recorded by a previous provider process before launch. */
export const reconcileStaleFirecrackerResources = async (
  config: FirecrackerConfig,
): Promise<void> => {
  await rm(join(config.paths.state, '.network-lock'), {
    recursive: true,
    force: true,
  });

  await rm(join(config.paths.cache, '.lru-lock'), {
    recursive: true,
    force: true,
  });

  const locks = join(config.paths.cache, 'locks');

  for (const lock of await readdir(locks).catch(() => [])) {
    await rm(join(locks, lock), { recursive: true, force: true });
  }

  const sandboxes = join(config.paths.state, 'sandboxes');

  for (const id of await readdir(sandboxes).catch(() => [])) {
    const directory = join(sandboxes, id);
    const jailDirectory = join(config.paths.state, 'jailer', 'firecracker', id);
    const tap = `doric${id.replaceAll('-', '').slice(0, 10)}`;
    const table = `doric_${id.replaceAll('-', '').slice(0, 12)}`;

    const raw = await readFile(join(directory, 'state.json'), 'utf8').catch(
      () => undefined,
    );
    const state = parse(raw);

    await terminateOwned(state.pid, id);

    await run({
      file: 'umount',
      args: [join(jailDirectory, 'root', 'base.ext4')],
    }).catch(() => undefined);

    await run({
      file: 'nft',
      args: ['delete', 'table', 'inet', table],
    }).catch(() => undefined);

    await run({
      file: 'nft',
      args: ['delete', 'table', 'ip', `${table}_nat`],
    }).catch(() => undefined);

    await run({ file: 'ip', args: ['link', 'delete', tap] }).catch(
      () => undefined,
    );

    await rm(join(config.paths.state, 'networks', id), { force: true });

    await removeUseMarkers(config.paths.cache, id);

    await rm(jailDirectory, { recursive: true, force: true });

    await rm(directory, { recursive: true, force: true });
  }
};

const terminateOwned = async (pid: unknown, id: string): Promise<void> => {
  const candidates = new Set<number>();

  if (Number.isInteger(pid) && (pid as number) > 1) {
    candidates.add(pid as number);
  }

  for (const entry of await readdir('/proc').catch(() => [])) {
    if (/^[1-9]\d*$/u.test(entry)) {
      candidates.add(Number(entry));
    }
  }

  for (const candidate of candidates) {
    const command = await readFile(
      `/proc/${String(candidate)}/cmdline`,
      'utf8',
    ).catch(() => '');

    if (
      !command.includes(id) ||
      (!command.includes('firecracker') && !command.includes('jailer'))
    ) {
      continue;
    }

    try {
      process.kill(candidate, 'SIGKILL');
    } catch {
      // The owned process already exited.
    }
  }
};

const parse = (raw: string | undefined): StaleState => {
  if (raw === undefined) {
    return {};
  }

  try {
    return JSON.parse(raw) as StaleState;
  } catch {
    return {};
  }
};

const removeUseMarkers = async (cache: string, id: string): Promise<void> => {
  const uses = join(cache, 'uses');

  for (const key of await readdir(uses).catch(() => [])) {
    await rm(join(uses, key, id), { force: true });
  }
};
