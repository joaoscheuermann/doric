import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { run, text } from './command.js';
import type { FirecrackerConfig } from './types.js';

const converterVersion = 'oci-ext4-v1';

export type PreparedImage = {
  readonly disk: string;
  readonly digest: string;
  readonly env: readonly string[];
  readonly user: string;
  release(): Promise<void>;
};

type ImageMetadata = {
  readonly digest: string;
  readonly env: readonly string[];
  readonly user: string;
};

/** Resolves a public linux/amd64 OCI image and returns an immutable cached ext4 disk. */
export const prepareImage = async (
  image: string,
  sandboxId: string,
  config: FirecrackerConfig,
  signal?: AbortSignal,
  pullPolicy: 'always' | 'if-not-present' = 'always',
): Promise<PreparedImage> => {
  validateReference(image);

  const cache = config.paths.cache;

  await mkdir(join(cache, 'locks'), { recursive: true, mode: 0o700 });

  await mkdir(join(cache, 'images'), { recursive: true, mode: 0o700 });

  await mkdir(join(cache, 'refs'), { recursive: true, mode: 0o700 });

  await mkdir(join(cache, 'uses'), { recursive: true, mode: 0o700 });

  const reference = join(
    cache,
    'refs',
    `${createHash('sha256').update(image).digest('hex')}.json`,
  );

  if (pullPolicy === 'if-not-present') {
    const cachedKey = await readReference(reference);

    if (cachedKey !== undefined) {
      const cached = await activate(
        cache,
        cachedKey,
        sandboxId,
        config.cacheLimitBytes,
        signal,
      );

      if (cached !== undefined) {
        return cached;
      }
    }
  }

  const acquisition = await mkdtemp(join(cache, '.acquire-'));

  try {
    const layout = join(acquisition, 'oci');

    await run({
      file: 'skopeo',
      args: [
        'copy',
        '--override-os',
        'linux',
        '--override-arch',
        'amd64',
        `docker://${image}`,
        `oci:${layout}:doric`,
      ],
      signal,
    });

    const digest = await manifestDigest(layout);

    const key = createHash('sha256')
      .update(`${digest}:${converterVersion}`)
      .digest('hex');
    const lock = await acquireLock(join(cache, 'locks', key), signal);

    try {
      const disk = join(cache, 'images', `${key}.ext4`);
      const metadataPath = join(cache, 'images', `${key}.json`);

      if (!(await exists(disk)) || !(await exists(metadataPath))) {
        await convert(layout, disk, metadataPath, digest, config, signal);
      }

      await writeAtomic(reference, JSON.stringify({ key }));

      const prepared = await activate(
        cache,
        key,
        sandboxId,
        config.cacheLimitBytes,
        signal,
      );

      if (prepared === undefined) {
        throw new Error('Firecracker image cache publication failed');
      }

      return prepared;
    } finally {
      await lock();
    }
  } finally {
    await rm(acquisition, { recursive: true, force: true });
  }
};

const activate = async (
  cache: string,
  key: string,
  sandboxId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PreparedImage | undefined> => {
  const unlockLru = await acquireLock(join(cache, '.lru-lock'), signal);
  const disk = join(cache, 'images', `${key}.ext4`);
  const metadataPath = join(cache, 'images', `${key}.json`);
  let marker: string | undefined;

  try {
    if (!(await exists(disk)) || !(await exists(metadataPath))) {
      return undefined;
    }

    const metadata = parseMetadata(await readFile(metadataPath, 'utf8'));
    const useDirectory = join(cache, 'uses', key);

    await mkdir(useDirectory, { recursive: true, mode: 0o700 });

    marker = join(useDirectory, sandboxId);

    await writeFile(marker, '', { mode: 0o600 });

    const activeMarker = marker;
    const now = new Date();

    await utimes(disk, now, now);

    await evict(cache, limit);

    return {
      disk,
      digest: metadata.digest,
      env: metadata.env,
      user: metadata.user,
      release: async () => {
        await rm(activeMarker, { force: true });
      },
    };
  } catch (cause) {
    if (marker !== undefined) {
      await rm(marker, { force: true });
    }

    throw cause;
  } finally {
    await unlockLru();
  }
};

const readReference = async (path: string): Promise<string | undefined> => {
  const raw = await readFile(path, 'utf8').catch(() => undefined);

  if (raw === undefined) {
    return undefined;
  }

  try {
    const value = JSON.parse(raw) as { readonly key?: unknown };

    return typeof value.key === 'string' && /^[a-f0-9]{64}$/u.test(value.key)
      ? value.key
      : undefined;
  } catch {
    return undefined;
  }
};

const convert = async (
  layout: string,
  disk: string,
  metadataPath: string,
  digest: string,
  config: FirecrackerConfig,
  signal?: AbortSignal,
): Promise<void> => {
  const work = `${disk}.${randomUUID()}.tmp`;
  const bundle = `${work}.bundle`;

  const configResult = await run({
    file: 'skopeo',
    args: ['inspect', '--config', `oci:${layout}:doric`],
    signal,
  });
  const metadata = configFrom(text(configResult.stdout), digest);

  try {
    await run({
      file: 'umoci',
      args: ['unpack', '--image', `${layout}:doric`, bundle],
      signal,
    });

    const rootfs = join(bundle, 'rootfs');

    await validateTree(rootfs, rootfs);

    const size = await treeSize(rootfs);

    const diskBytes = Math.max(
      512 * 1024 ** 2,
      Math.ceil(size * 1.3 + 64 * 1024 ** 2),
    );

    if (diskBytes > config.cacheLimitBytes) {
      throw new Error('OCI image cannot fit in the Firecracker rootfs cache');
    }

    await run({
      file: 'truncate',
      args: ['-s', String(diskBytes), work],
      signal,
    });

    await run({
      file: 'mkfs.ext4',
      args: ['-F', '-q', '-d', rootfs, work],
      signal,
    });

    await chmod(work, 0o400);

    await rename(work, disk);

    await writeAtomic(metadataPath, JSON.stringify(metadata));
  } finally {
    await rm(work, { force: true });

    await rm(bundle, { recursive: true, force: true });
  }
};

const manifestDigest = async (layout: string): Promise<string> => {
  const index = JSON.parse(
    await readFile(join(layout, 'index.json'), 'utf8'),
  ) as {
    manifests?: readonly { readonly digest?: unknown }[];
  };
  const digest = index.manifests?.[0]?.digest;

  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('OCI copy did not produce one valid linux/amd64 manifest');
  }

  return digest;
};

const configFrom = (raw: string, digest: string): ImageMetadata => {
  const parsed = JSON.parse(raw) as {
    architecture?: unknown;
    os?: unknown;
    config?: { Env?: unknown; User?: unknown };
  };

  if (parsed.architecture !== 'amd64' || parsed.os !== 'linux') {
    throw new Error('OCI image platform must be linux/amd64');
  }

  const env = Array.isArray(parsed.config?.Env)
    ? parsed.config.Env.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const user =
    typeof parsed.config?.User === 'string' ? parsed.config.User : '';

  return { digest, env, user };
};

const validateTree = async (root: string, path: string): Promise<void> => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);

    if (entry.isDirectory()) {
      await validateTree(root, child);

      continue;
    }

    if (entry.isSymbolicLink()) {
      const target = await readlink(child);

      const destination = target.startsWith('/')
        ? resolve(root, target.slice(1))
        : resolve(dirname(child), target);

      if (!inside(root, destination)) {
        throw new Error('OCI image contains an escaping symbolic link');
      }

      continue;
    }

    if (!entry.isFile()) {
      throw new Error('OCI image contains an unsupported special file');
    }
  }
};

const treeSize = async (root: string): Promise<number> => {
  let total = 0;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      total += await treeSize(path);
    } else if (entry.isFile()) {
      total += (await stat(path)).size;
    }
  }

  return total;
};

const evict = async (cache: string, limit: number): Promise<void> => {
  const directory = join(cache, 'images');

  const candidates = await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith('.ext4'))
      .map(async (name) => ({
        name,
        stats: await stat(join(directory, name)),
      })),
  );
  let total = candidates.reduce((sum, item) => sum + item.stats.size, 0);

  for (const item of candidates.sort(
    (left, right) => left.stats.mtimeMs - right.stats.mtimeMs,
  )) {
    if (total <= limit) {
      return;
    }

    const key = item.name.slice(0, -'.ext4'.length);

    if ((await readdir(join(cache, 'uses', key)).catch(() => [])).length > 0) {
      continue;
    }

    await rm(join(directory, item.name), { force: true });

    await rm(join(directory, `${key}.json`), { force: true });

    total -= item.stats.size;
  }

  if (total > limit) {
    throw new Error('Firecracker rootfs cache is full with in-use images');
  }
};

const acquireLock = async (
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

      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
};

const writeAtomic = async (path: string, value: string): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;

  await writeFile(temporary, value, { mode: 0o600 });

  await rename(temporary, path);
};

const parseMetadata = (raw: string): ImageMetadata => {
  const value = JSON.parse(raw) as Partial<ImageMetadata>;

  if (
    typeof value.digest !== 'string' ||
    typeof value.user !== 'string' ||
    !Array.isArray(value.env)
  ) {
    throw new Error('Firecracker image cache metadata is invalid');
  }

  return {
    digest: value.digest,
    user: value.user,
    env: value.env.filter((item): item is string => typeof item === 'string'),
  };
};

const validateReference = (image: string): void => {
  if (image.length === 0 || image.includes('://') || /\s/u.test(image)) {
    throw new Error(
      'Firecracker image must be a public OCI registry reference',
    );
  }
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const inside = (root: string, path: string): boolean => {
  const value = relative(root, path);

  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..');
};

const isCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  cause.code === code;
