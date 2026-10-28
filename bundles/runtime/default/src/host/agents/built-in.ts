import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * One agent definition file. `path` names the file in error messages; its
 * base name `<name>.md` gives the agent's name. `text` is its full UTF-8
 * contents.
 */
export interface AgentFile {
  readonly path: string;
  readonly text: string;
}

/** The names of the agents shipped with the bundle, in order: `./<name>.md` each. */
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

/**
 * The definitions shipped with the bundle: `./<name>.md` next to this module,
 * read with `readFileSync` at import (a missing file fails the import).
 */
export const builtInAgentFiles: readonly AgentFile[] = BUILT_IN_AGENT_NAMES.map(
  (name) => {
    const path = fileURLToPath(new URL(`./${name}.md`, import.meta.url));
    return { path, text: readFileSync(path, 'utf8') };
  },
);
