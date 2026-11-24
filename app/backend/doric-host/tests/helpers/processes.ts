import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * The processes an operator sees with `ps`: the direct children of a process,
 * read from Linux's `/proc` (each `stat` names the parent; each `cmdline` the
 * arguments). The bundle processes the platform spawns are the host's direct
 * children; what they start in turn is not.
 */

/**
 * The bundles of the shipped composition (sandbox `docker`) that have no host
 * part: desktop bundles the catalog lists active and the platform never spawns.
 */
export const clientOnlyBundles: readonly string[] = [
  'account',
  'history',
  'layout',
  'notifications',
  'settings',
  'workspace',
];

/**
 * The bundles of the shipped composition (sandbox `docker`) with a host part:
 * one process each (AC3.1). With {@link clientOnlyBundles}, the 32 the
 * catalog lists active (`Bundles loaded`'s `bundleCount`, group D Q3(ii)).
 */
export const hostPartBundles: readonly string[] = [
  'chat',
  'claude',
  'claude-login',
  'codex',
  'comments',
  'core',
  'default',
  'docker',
  'files',
  'git',
  'host-config',
  'mcp',
  'openai',
  'openrouter',
  'openui',
  'papercraft',
  'postgres',
  'resources',
  'runtime',
  'screen',
  'screen-relay',
  'terminal',
  'threads',
  'transport',
  'usage',
  'web',
];

export interface ChildProcessInfo {
  readonly pid: number;
  /** The command line, `argv[0]` first. */
  readonly args: readonly string[];
}

/** The parent pid in `/proc/<pid>/stat`, after the parenthesized command name. */
const parentOf = (stat: string): number | undefined => {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

  return Number.parseInt(fields[1] ?? '', 10);
};

/** The live direct children of `parent`; a process that exits meanwhile is left out. */
export const childProcesses = async (
  parent: number,
): Promise<readonly ChildProcessInfo[]> => {
  const children: ChildProcessInfo[] = [];

  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;

    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');

      // A zombie has exited; `ps` shows it defunct, not running.
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) continue;
      if (parentOf(stat) !== parent) continue;

      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8');

      children.push({
        pid: Number.parseInt(entry, 10),
        args: cmdline.split('\0').filter((part) => part !== ''),
      });
    } catch {
      // Gone between the listing and the read.
    }
  }

  return children;
};

/**
 * The bundle each child runs, by the command `stage --dev` staged for it
 * (`<bundlesPath>/<id>/host/command.json`, `["node", "<main.mjs>"]`); a child
 * that runs none of them is named by its command line.
 */
export const spawnedBundles = async (
  bundlesPath: string,
  children: readonly ChildProcessInfo[],
): Promise<readonly string[]> => {
  const commands = new Map<string, string>();

  for (const id of await readdir(bundlesPath)) {
    try {
      const command = JSON.parse(
        await readFile(join(bundlesPath, id, 'host', 'command.json'), 'utf8'),
      ) as readonly string[];
      const script = command.at(-1);

      if (script !== undefined) commands.set(script, id);
    } catch {
      // No staged command: a client-only bundle.
    }
  }

  return children.map(
    ({ args }) =>
      args.map((arg) => commands.get(arg)).find((id) => id !== undefined) ??
      args.join(' '),
  );
};
