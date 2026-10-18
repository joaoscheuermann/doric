// The views list on disk: one JSON file in the bundle's own cache directory,
// replaced atomically (temp + rename) on every change, as the history cache and
// the core's settings file are. Nothing here throws: a missing, unreadable or
// corrupt file reads as an empty list, so a bad write can never stop the app.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** The views file, in the directory `doric.cache/v1` gives this bundle. */
export const VIEWS_FILE = 'views.json';

/** One view as the file stores it: what survives an app restart. */
export interface StoredView {
  readonly id: string;
  readonly label: string;
  readonly projectId: string;
}

/** The whole file. The status is never stored: it is asked for again. */
export interface StoredViews {
  readonly version: 1;
  readonly views: readonly StoredView[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const storedView = (value: unknown): StoredView | undefined => {
  const entry = record(value);

  return entry === undefined ||
    !nonEmpty(entry.id) ||
    !nonEmpty(entry.label) ||
    !nonEmpty(entry.projectId)
    ? undefined
    : { id: entry.id, label: entry.label, projectId: entry.projectId };
};

/** A file that does not hold a views list reads as no views at all. */
export const viewsFrom = (value: unknown): readonly StoredView[] => {
  const saved = record(value);

  if (
    saved === undefined ||
    saved.version !== 1 ||
    !Array.isArray(saved.views)
  ) {
    return [];
  }

  const views = saved.views.map(storedView);

  return views.some((view) => view === undefined)
    ? []
    : views.map((view) => view as StoredView);
};

/** Where the views file lives; resolved lazily, on the first read or write. */
export type ViewsDirectory = () => Promise<string>;

export interface ViewsFile {
  /** The stored views; empty when the file is missing or unreadable. */
  read(): Promise<readonly StoredView[]>;
  /** Replaces the file atomically; a failure leaves it as it was. */
  write(views: readonly StoredView[]): Promise<void>;
}

/**
 * The views file over one lazily-resolved directory. `DoricCacheV1` is asked
 * for the directory on the first use, never during activation: the desktopMain
 * generation's activation is also recorded at build time, where the platform's
 * services answer no directory at all.
 */
export const createViewsFile = (directory: ViewsDirectory): ViewsFile => {
  return {
    read: async () => {
      try {
        const path = join(await directory(), VIEWS_FILE);

        return viewsFrom(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        // Missing, unreadable or not JSON: no views, never a failure.
        return [];
      }
    },
    write: async (views) => {
      const dir = await directory();
      const target = join(dir, VIEWS_FILE);
      const temporary = `${target}.tmp`;
      const file: StoredViews = { version: 1, views };

      mkdirSync(dir, { recursive: true });

      try {
        writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
        renameSync(temporary, target);
      } catch (error) {
        try {
          rmSync(temporary, { force: true });
        } catch {
          // Nothing to clean up.
        }

        throw error;
      }
    },
  };
};
