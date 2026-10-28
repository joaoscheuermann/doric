import type { Call } from 'bundle/contracts';
import { type RuntimeWorkspace, RuntimeWorkspaceV1 } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

const description =
  "Report this thread's working directory, or move it to a given path. A relative path resolves against the current directory, the way cd does. A move takes effect only when the path is a directory inside the workspace root, and every other tool resolves its relative paths against this directory. Move here as soon as the work moves into a repository or a subdirectory - after a clone, for instance - so the other tools run in it.";

export const input = z.object({ path: z.string().optional() }).strict();

/** The reminder a `cwd` result carries when the directory is a Git repository's root. */
export const repositoryNote =
  'Remember to load the skills that match your task when working in a repository.';

export const output = z
  .object({
    cwd: z.string(),
    status: z.enum(['reported', 'set', 'refused']),
    reason: z.enum(['outside', 'missing', 'not-directory']).optional(),
    repositoryRoot: z.boolean(),
    note: z.string().optional(),
  })
  .strict();

export type CwdOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

/** Creates the provider-neutral working directory tool. */
export const tool = defineTool({
  name: 'cwd',
  description,
  input,
  output,
  execute: (input, call, services): Promise<CwdOutput> =>
    execute(services.use(RuntimeWorkspaceV1, call.scope), call, input),
});

/**
 * A refusal keeps the current directory and names why, so the model corrects
 * its own path instead of handling a thrown failure. Every outcome then reads
 * `location()`, so `cwd` and `repositoryRoot` describe the directory the Thread
 * is in after the call, and a repository root adds the note. A path that is
 * absent, or blank once trimmed, names no directory - the HTTP route reads such
 * a value the same way - so it reports the current one instead. A path that is
 * given is trimmed here, exactly as the route trims it, so one rule sees one
 * spelling.
 */
const execute = async (
  workspace: RuntimeWorkspace,
  call: Call,
  input: Input,
): Promise<CwdOutput> => {
  const path = input.path?.trim();
  const change =
    path === undefined || path === ''
      ? undefined
      : await workspace.setCwd(path, call);
  // One read after every outcome: the directory the Thread is in now, and
  // whether it is a repository root.
  const { cwd, repo } = await workspace.location(call);
  const repository =
    repo === undefined
      ? { repositoryRoot: false }
      : { repositoryRoot: true, note: repositoryNote };

  if (change === undefined) return { cwd, status: 'reported', ...repository };
  if (change.status === 'set') return { cwd, status: 'set', ...repository };
  return { cwd, status: 'refused', reason: change.status, ...repository };
};
