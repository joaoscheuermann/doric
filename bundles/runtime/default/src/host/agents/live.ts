import type { Call, Services } from 'bundle/contracts';

import type { AgentSummary } from '../../contracts/index.js';
import { bundleInstruction } from '../envelope.js';
import { currentCwd } from '../skills/sources.js';
import { agentCatalogChange } from './catalog.js';
import { effectiveAgents, readWorkspaceAgents } from './definitions.js';

/** The run's agents as its working directory moves. */
export interface LiveAgents {
  /**
   * Reads `currentCwd(call)`; when known and different from the last
   * directory read, recomputes the agents in effect with
   * `readWorkspaceAgents`, else keeps the last agents. Then compares them by
   * `agentCatalogChange` with the last announced agents, or with the start
   * agents after `rebase`. Returns `bundleInstruction('agents-changed',
   * message)` when there is a message, else undefined. Never rejects; calls
   * run one after another.
   */
  refresh(): Promise<string | undefined>;
  /** After a compaction, the next `refresh` compares with the start agents. */
  rebase(): void;
}

/**
 * Starts from the system prompt's agents (`cwd = thread.cwd`); no call
 * before the first `refresh`.
 */
export const liveAgents = (
  start: { readonly cwd: string; readonly agents: readonly AgentSummary[] },
  builtIn: readonly AgentSummary[],
  call: Call,
  services: Services,
): LiveAgents => {
  let cwd = start.cwd;
  let agents = start.agents;
  /** The agents the next check compares with: the last announced ones, or the start ones after `rebase`. */
  let baseline = start.agents;
  /** The last check, so the next one starts after it. */
  let running: Promise<unknown> = Promise.resolve();

  const check = async (): Promise<string | undefined> => {
    const now = await currentCwd(call, services);
    if (now !== undefined && now !== cwd) {
      cwd = now;
      agents = effectiveAgents(
        builtIn,
        await readWorkspaceAgents(now, call, services),
      );
    }
    const message = agentCatalogChange(baseline, agents);
    baseline = agents;
    return message === undefined
      ? undefined
      : bundleInstruction('agents-changed', message);
  };

  return {
    refresh: () => {
      const next = running.then(check);
      running = next;
      return next;
    },
    rebase: () => {
      baseline = start.agents;
    },
  };
};
