import { assetText, builtInAgentPaths } from '../assets.js';

/**
 * One agent definition file. `path` names the file in error messages; its
 * base name `<name>.md` gives the agent's name. `text` is its full UTF-8
 * contents.
 */
export interface AgentFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The definitions shipped with the bundle, in order: `src/host/agents/<name>.md`, read through `assetText` on
 * each call (no read at import).
 */
export const builtInAgentFiles = (): readonly AgentFile[] =>
  builtInAgentPaths.map((path) => ({ path, text: assetText(path) }));
