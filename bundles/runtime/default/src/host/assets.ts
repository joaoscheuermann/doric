import { readFileSync } from 'node:fs';

/** The built-in agents, in workflow order: `src/host/agents/<name>.md` each. */
const BUILT_IN_AGENT_NAMES: readonly string[] = [
  'triage',
  'search',
  'spec',
  'review',
  'plan',
  'contracts',
  'tests',
  'implementation',
  'cleanup',
  'docs',
];

/** The templates of `src/host/prompts`, by file name. */
const PROMPT_NAMES: readonly string[] = [
  'agent',
  'agents-changed',
  'agents',
  'loaded-skills',
  'skills-catalog',
  'skills-changed',
  'system',
];

/** The bundle-relative paths of the built-in agents, in workflow order (the order `default.agents/v1` lists them). */
export const builtInAgentPaths: readonly string[] = BUILT_IN_AGENT_NAMES.map(
  (name) => `src/host/agents/${name}.md`,
);

/**
 * The files the host part reads, relative to the bundle directory, in a fixed order: the seven
 * `src/host/prompts/*.md` and the ten `src/host/agents/<name>.md` of the built-in agents. What `host.assets` must
 * match (S62: `["src/host/prompts/*.md", "src/host/agents/*.md"]`).
 */
export const defaultAssetPaths: readonly string[] = [
  ...PROMPT_NAMES.map((name) => `src/host/prompts/${name}.md`),
  ...builtInAgentPaths,
];

/** The texts `useAssetTexts` installed; undefined while the files beside the module are the source. */
let installed: ReadonlyMap<string, string> | undefined;

/** The files read from disk so far, by path (read once each). */
const fromDisk = new Map<string, string>();

/**
 * Makes `texts` (path → UTF-8 text) the source of every later `assetText`, for the whole process; a later call
 * replaces it. Templates and agent files are read again from the new source on their next use.
 */
export const useAssetTexts = (texts: ReadonlyMap<string, string>): void => {
  installed = texts;
};

/**
 * The text of asset `path` (one of `defaultAssetPaths`): from the installed texts when `useAssetTexts` was called,
 * else read from disk beside this module (`src/host/…` resolved against this module's directory, as today's
 * `import.meta.url` reads). Throws an `Error` naming `path` when the installed texts lack it, or the file's read
 * error (`ENOENT`) when nothing was installed and the file is missing. Never reads at import.
 */
export const assetText = (path: string): string => {
  if (installed !== undefined) {
    const text = installed.get(path);
    if (text === undefined)
      throw new Error(`Asset "${path}" is not among the installed texts.`);
    return text;
  }
  let text = fromDisk.get(path);
  if (text === undefined) {
    // This module is `src/host/assets.js`: the bundle directory is two folders above.
    text = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    fromDisk.set(path, text);
  }
  return text;
};

/**
 * Reads every `defaultAssetPaths` entry through `read` (the host part passes `context.assets.read`), in order, and
 * decodes each as UTF-8. Rejects with the first read's error (`HostAssets.read` names the path and the bundle).
 */
export const loadAssetTexts = async (
  read: (path: string) => Promise<Uint8Array>,
): Promise<ReadonlyMap<string, string>> => {
  const decoder = new TextDecoder();
  const texts = new Map<string, string>();
  for (const path of defaultAssetPaths) {
    texts.set(path, decoder.decode(await read(path)));
  }
  return texts;
};
