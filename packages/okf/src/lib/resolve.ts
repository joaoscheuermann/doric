import fs from 'node:fs/promises';
import path from 'node:path';

import { SUPPORTED_EXTENSIONS } from './detect.js';
import type {
  ExtractedImport,
  ImportEntry,
  ModuleImports,
} from './types/interface.js';

type ResolveInput = {
  readonly root: string;
  readonly source: string;
};

/** Resolves and groups extracted module sources into deterministic imports. */
export const resolveImports = async (
  input: ResolveInput,
  imports: readonly ExtractedImport[],
): Promise<ModuleImports | undefined> => {
  const merged = new Map<string, Set<string>>();

  for (const item of imports) {
    const symbols = merged.get(item.source) ?? new Set<string>();

    item.symbols.forEach((symbol) => symbols.add(symbol));

    merged.set(item.source, symbols);
  }

  const entries = await Promise.all(
    [...merged.entries()].map(
      async ([source, symbols]): Promise<ImportEntry> => ({
        source,
        ...(source.startsWith('.')
          ? { target: await resolveRelative(input, source) }
          : {}),
        symbols: [...symbols].sort(compare),
      }),
    ),
  );

  const relative = entries
    .filter(({ source }) => source.startsWith('.'))
    .sort(importCompare);

  const external = entries
    .filter(({ source }) => !source.startsWith('.'))
    .sort(importCompare);

  if (relative.length === 0 && external.length === 0) {
    return undefined;
  }

  return {
    ...(relative.length === 0 ? {} : { relative }),
    ...(external.length === 0 ? {} : { external }),
  };
};

const resolveRelative = async (
  input: ResolveInput,
  specifier: string,
): Promise<string | null> => {
  const base = path.resolve(
    input.root,
    path.posix.dirname(input.source),
    specifier,
  );

  if (!contained(input.root, base)) {
    return null;
  }

  const extensions = SUPPORTED_EXTENSIONS.map(
    (extension) => `${base}.${extension}`,
  );

  const indexes = SUPPORTED_EXTENSIONS.map((extension) =>
    path.join(base, `index.${extension}`),
  );

  const candidates = path.extname(base)
    ? [base, ...indexes]
    : [base, ...extensions, ...indexes];

  for (const candidate of candidates) {
    try {
      if (!(await fs.lstat(candidate)).isFile()) {
        continue;
      }

      const physical = await fs.realpath(candidate);

      if (!contained(input.root, physical)) {
        continue;
      }

      return path.relative(input.root, candidate).split(path.sep).join('/');
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  return null;
};

const contained = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);

  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
};

const importCompare = (left: ImportEntry, right: ImportEntry): number =>
  compare(left.source, right.source) ||
  compare(left.target ?? '', right.target ?? '') ||
  compare(left.symbols.join('\0'), right.symbols.join('\0'));

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');
