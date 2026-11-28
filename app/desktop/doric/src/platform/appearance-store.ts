// The appearance preference main keeps in `userData/doric/appearance.json`
// (§4.1): the theme and whether app windows are frosted glass. Read once when
// the platform prepares; written atomically on each choice.

import { doricThemeSchema } from 'bundle/contracts';
import { z } from 'zod';

import type { ThemeSource } from './appearance';
import { readJson, writeJsonAtomic } from './state';

/**
 * `appearance.json`: `{ "theme": "dark" | "light" | "system", "glass"?: boolean }`,
 * nothing else. A file written before `glass` existed holds only the theme.
 */
export const appearanceFileSchema = z
  .object({ theme: doricThemeSchema, glass: z.boolean().optional() })
  .strict();

/**
 * The saved appearance preference, held in memory after one read.
 * Invariant: `get()` and `glass()` answer what the file last held after a
 * successful read or write; a missing, unparsable or unknown file reads as
 * `dark` with glass on (P2), and a file without `glass` reads as glass on.
 */
export class AppearanceStore {
  readonly #path: string;
  #theme: ThemeSource;
  #glass: boolean;

  private constructor(path: string, theme: ThemeSource, glass: boolean) {
    this.#path = path;
    this.#theme = theme;
    this.#glass = glass;
  }

  /**
   * Reads `path` once. Never rejects: a file that is missing, not JSON, or
   * not exactly `appearanceFileSchema` gives a store that answers `dark` and
   * glass on.
   */
  static async open(path: string): Promise<AppearanceStore> {
    const file = await readJson(path, appearanceFileSchema);

    return new AppearanceStore(
      path,
      file?.theme ?? 'dark',
      file?.glass ?? true,
    );
  }

  /** The theme held in memory (synchronous). */
  get(): ThemeSource {
    return this.#theme;
  }

  /** Whether app windows are frosted glass, held in memory (synchronous). */
  glass(): boolean {
    return this.#glass;
  }

  /**
   * Writes `{ theme, glass }` atomically, then holds the theme. A write that
   * throws leaves the held values unchanged and rethrows.
   */
  async set(theme: ThemeSource): Promise<void> {
    await writeJsonAtomic(this.#path, { theme, glass: this.#glass });
    this.#theme = theme;
  }

  /**
   * Writes `{ theme, glass }` atomically, then holds `glass`. A write that
   * throws leaves the held values unchanged and rethrows.
   */
  async setGlass(glass: boolean): Promise<void> {
    await writeJsonAtomic(this.#path, { theme: this.#theme, glass });
    this.#glass = glass;
  }
}
