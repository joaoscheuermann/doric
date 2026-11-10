// The theme preference main keeps in `userData/doric/appearance.json` (§4.1).
// Read once when the platform prepares; written atomically on each choice.

import { doricThemeSchema } from 'bundle/contracts';
import { z } from 'zod';

import type { ThemeSource } from './appearance';
import { readJson, writeJsonAtomic } from './state';

/** `appearance.json`: `{ "theme": "dark" | "light" | "system" }`, nothing else. */
export const appearanceFileSchema = z
  .object({ theme: doricThemeSchema })
  .strict();

/**
 * The saved theme preference, held in memory after one read.
 * Invariant: `get()` answers what the file last held after a successful
 * read or write; a missing, unparsable or unknown file reads as `dark` (P2).
 */
export class AppearanceStore {
  readonly #path: string;
  #theme: ThemeSource;

  private constructor(path: string, theme: ThemeSource) {
    this.#path = path;
    this.#theme = theme;
  }

  /**
   * Reads `path` once. Never rejects: a file that is missing, not JSON, or
   * not exactly `appearanceFileSchema` gives a store that answers `dark`.
   */
  static async open(path: string): Promise<AppearanceStore> {
    const file = await readJson(path, appearanceFileSchema);

    return new AppearanceStore(path, file?.theme ?? 'dark');
  }

  /** The preference held in memory (synchronous). */
  get(): ThemeSource {
    return this.#theme;
  }

  /**
   * Writes `{ theme }` atomically, then holds it. A write that throws leaves
   * the held value unchanged and rethrows.
   */
  async set(theme: ThemeSource): Promise<void> {
    await writeJsonAtomic(this.#path, { theme });
    this.#theme = theme;
  }
}
