// Small JSON files of the desktop platform, written atomically (temporary
// file, fsync, rename) so a crash never leaves a half-written file.

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/** Writes `value` as JSON to `path` through a temporary file and a rename. */
export const writeJsonAtomic = async (
  path: string,
  value: unknown,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${randomBytes(6).toString('hex')}.tmp`,
  );
  const handle = await open(temporary, 'w');

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** The parsed file, or `undefined` when it is missing or invalid. */
export const readJson = async <T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> => {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = schema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** The core desktopMain part that last activated, kept for recovery. */
export interface LastGoodCore {
  readonly id: string;
  readonly version: string;
  /** The local generation it activated in. */
  readonly generation: number;
  /** Its distribution entry (files verified in the artifact cache). */
  readonly bundle: unknown;
}

export interface DesktopStateData {
  readonly migrations: { readonly selectionOrigin?: true };
  readonly lastGoodCore?: LastGoodCore;
}

const stateSchema: z.ZodType<DesktopStateData> = z.object({
  migrations: z.object({ selectionOrigin: z.literal(true).optional() }),
  lastGoodCore: z
    .object({
      id: z.string(),
      version: z.string(),
      generation: z.number().int(),
      bundle: z.unknown(),
    })
    .optional(),
});

/** `userData/doric/state.json`. */
export class DesktopState {
  readonly #path: string;
  #data: DesktopStateData;
  #writing: Promise<void> = Promise.resolve();

  private constructor(path: string, data: DesktopStateData) {
    this.#path = path;
    this.#data = data;
  }

  static async open(path: string): Promise<DesktopState> {
    return new DesktopState(
      path,
      (await readJson(path, stateSchema)) ?? { migrations: {} },
    );
  }

  get data(): DesktopStateData {
    return this.#data;
  }

  /** Applies a change and writes the file (writes are serialized). */
  update(change: (data: DesktopStateData) => DesktopStateData): Promise<void> {
    this.#data = change(this.#data);
    const data = this.#data;

    this.#writing = this.#writing
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.#path, data));

    return this.#writing;
  }

  flush(): Promise<void> {
    return this.#writing.catch(() => undefined);
  }
}

const windowsSchema = z.object({
  lastPaths: z.record(z.string(), z.string()),
});

/** How long a navigation waits before its last path is written. */
export const LAST_PATH_DEBOUNCE_MS = 250;

/**
 * `userData/doric/windows.json`: the last path main loaded for each window
 * key (decision 75). Bounds are neither stored nor restored (Q1, parity).
 */
export class WindowPaths {
  readonly #path: string;
  readonly #paths: Map<string, string>;
  readonly #debounceMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<void> = Promise.resolve();

  private constructor(
    path: string,
    paths: Map<string, string>,
    debounceMs: number,
  ) {
    this.#path = path;
    this.#paths = paths;
    this.#debounceMs = debounceMs;
  }

  static async open(
    path: string,
    debounceMs = LAST_PATH_DEBOUNCE_MS,
  ): Promise<WindowPaths> {
    const data = await readJson(path, windowsSchema);

    return new WindowPaths(
      path,
      new Map(Object.entries(data?.lastPaths ?? {})),
      debounceMs,
    );
  }

  get(key: string): string | null {
    return this.#paths.get(key) ?? null;
  }

  /** Records a path; the file is written after the debounce. */
  set(key: string, path: string): void {
    if (this.#paths.get(key) === path) {
      return;
    }

    this.#paths.set(key, path);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#write();
    }, this.#debounceMs);
  }

  #write(): Promise<void> {
    const lastPaths = Object.fromEntries(this.#paths);

    this.#writing = this.#writing
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.#path, { lastPaths }));

    return this.#writing;
  }

  /** Writes now (window closed, quit). */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      await this.#write();
    }

    await this.#writing.catch(() => undefined);
  }
}
