import type { Call, Services } from 'bundle/contracts';

import { bundleInstruction } from '../envelope.js';
import {
  type CatalogState,
  type SkillCatalog,
  skillCatalogChange,
} from './catalog.js';
import {
  type CatalogSkill,
  currentCwd,
  type RunSkills,
  readServerSkills,
  readWorkspaceSkills,
} from './sources.js';

/** The run's catalog as it changes while the run goes on. */
export interface LiveCatalog {
  /** The locators load_skill accepts now (CatalogState.listed of the latest state). */
  listed(): ReadonlyMap<string, CatalogSkill>;
  /**
   * currentCwd (failure = unchanged); readWorkspaceSkills only when the cwd
   * differs from the last read (failed scan of a new cwd → []), else reuse
   * the last workspace list; readServerSkills (failure keeps the last list);
   * skillCatalogChange against the current diff baseline; returns
   * bundleInstruction('skills-changed', message) when there is a message,
   * else undefined. Never rejects; calls don't overlap.
   */
  refresh(): Promise<string | undefined>;
  /**
   * After a compaction that finished `compacted`: the next refresh compares
   * against the start catalog (the system prompt's lists) instead of the last
   * announced state; locators kept; listed() unchanged until that next
   * refresh.
   */
  rebase(): void;
}

/**
 * Starts from the state the system prompt was built from (cwd = thread.cwd,
 * skills = readRunSkills result, catalog = skillCatalog(skills)); no call
 * until the first refresh.
 */
export const liveCatalog = (
  start: {
    readonly cwd: string;
    readonly skills: RunSkills;
    readonly catalog: SkillCatalog;
  },
  call: Call,
  services: Services,
): LiveCatalog => {
  let cwd = start.cwd;
  let { workspace, server } = start.skills;
  /** The state the next check compares with: the last announced one. */
  let baseline: CatalogState = start.catalog;
  /** Set by `rebase`: the next check compares with the start lists. */
  let rebased = false;
  /** The last check, so the next one starts after it. */
  let running: Promise<unknown> = Promise.resolve();

  const check = async (): Promise<string | undefined> => {
    const now = await currentCwd(call, services);
    if (now !== undefined && now !== cwd) {
      cwd = now;
      workspace = await readWorkspaceSkills(now, call, services);
    }
    server = (await readServerSkills(call, services)) ?? server;
    const from: CatalogState = rebased
      ? {
          locators: baseline.locators,
          available: start.catalog.available,
          listed: start.catalog.listed,
        }
      : baseline;
    rebased = false;
    const { state, message } = skillCatalogChange(from, { workspace, server });
    baseline = state;
    return message === undefined
      ? undefined
      : bundleInstruction('skills-changed', message);
  };

  return {
    listed: () => baseline.listed,
    refresh: () => {
      const next = running.then(check);
      running = next;
      return next;
    },
    rebase: () => {
      rebased = true;
    },
  };
};
