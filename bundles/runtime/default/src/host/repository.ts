import type { Call } from 'bundle/contracts';
import type {
  CwdChanged,
  InputSource,
  RuntimeThreads,
  ThreadAgent,
} from 'runtime/contracts';

import { loadTemplate, render } from './prompts/templates.js';

/** The coding-workflow instruction for a thread whose working directory is a Git repository's root; its text lives in `prompts/repository.md`. */
const repositoryPrompt = render(
  loadTemplate(new URL('./prompts/repository.md', import.meta.url), []),
  {},
);

/** The runtime's Thread controls, while some bundle provides them. */
export type ThreadControls = () => Pick<RuntimeThreads, 'instruct'> | undefined;

/** The reason the coding workflow instruction names. */
export const reason = 'coding-workflow';

/** The key a standing instruction is retained under in the history's meta. */
export const retainedKey = (bundleId: string, why: string): string =>
  `${bundleId}:${why}`;

/** The coding workflow's own key: the `default` bundle gives it. */
export const workflowKey = retainedKey('default', reason);

/** One running prompt, as the workflow reads it. */
export interface WorkflowRun {
  readonly threadId: string;
  readonly promptId: string;
  /** Whether the history the model reads holds the instruction `key`. */
  retains(key: string): boolean;
}

/**
 * The coding workflow, given once per Thread as a standing instruction
 * (`runtime.threads/v1.instruct` with `retain`): whenever the prompt's
 * history does not hold it yet — its first task at a repository root, or
 * after a rewind removed it. Compaction keeps it, so it is not given again.
 * A Thread running as an agent never receives it: the agent's instructions are
 * its workflow.
 */
export const createWorkflow = (threads: ThreadControls) => {
  const runs = new Map<string, WorkflowRun>();
  /** The prompts with an instruction given and not yet in their history. */
  const giving = new Set<string>();

  const give = async (run: WorkflowRun, call: Call): Promise<void> => {
    if (run.retains(workflowKey) || giving.has(run.promptId)) return;
    giving.add(run.promptId);
    const result = await threads()?.instruct(
      {
        id: run.threadId,
        promptId: run.promptId,
        prompt: repositoryPrompt,
        reason,
        retain: true,
      },
      call,
    );
    if (result?.status !== 'steered' && result?.status !== 'queued')
      giving.delete(run.promptId);
  };

  return {
    /**
     * A run started, before its first model request: a new task — the
     * reader's request or a parent's delegated step — at a repository root
     * receives the workflow, read before that request. A run with `at.agent`
     * is not registered, so neither this call nor `onCwdChanged` gives it the
     * workflow. Rejects only when `runtime.threads/v1.instruct` rejects.
     */
    start: async (
      run: WorkflowRun,
      at: {
        readonly cwdRepo?: string;
        readonly source: InputSource;
        readonly agent?: ThreadAgent;
      },
      call: Call,
    ): Promise<void> => {
      if (at.agent !== undefined) return;
      runs.set(run.promptId, run);
      if (at.cwdRepo === undefined) return;
      if (at.source.kind !== 'user' && at.source.kind !== 'parent') return;
      await give(run, call);
    },
    /** The run ended: it hears no more moves. */
    end: (promptId: string): void => {
      runs.delete(promptId);
      giving.delete(promptId);
    },
    /**
     * `onThreadCwdChangedHook`: a running prompt `start` registered that moves
     * to a repository root receives the workflow after the tool batch that
     * moved it; any other prompt is ignored.
     */
    onCwdChanged: async (input: CwdChanged, call: Call): Promise<void> => {
      if (input.cwdRepo === undefined || input.promptId === undefined) return;
      const run = runs.get(input.promptId);
      if (run !== undefined) await give(run, call);
    },
  };
};

export type Workflow = ReturnType<typeof createWorkflow>;
