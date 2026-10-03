import { z } from 'zod';

import { defineTool } from 'tool';

const description =
  "Report this thread's working directory, or move it to a given path. A relative path resolves against the current directory, the way cd does. A move takes effect only when the path is a directory inside the workspace root, and every other tool resolves its relative paths against this directory. Move here as soon as the work moves into a repository or a subdirectory - after a clone, for instance - so the other tools run in it.";

export const input = z.object({ path: z.string().optional() }).strict();

export const output = z
  .object({
    cwd: z.string(),
    status: z.enum(['reported', 'set', 'refused']),
    reason: z.enum(['outside', 'missing', 'not-directory']).optional(),
  })
  .strict();

export type CwdOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

/**
 * What this tool needs of the host facade. The host owns the Thread's
 * directory and decides what a move does; this tool only asks and reports.
 */
interface Workspace {
  cwd(): string;
  setCwd(path: string): Promise<CwdChange>;
}

/** The host's answer to a move: the new directory, or why nothing moved. */
type CwdChange =
  | { readonly status: 'set'; readonly cwd: string }
  | { readonly status: 'outside' | 'missing' | 'not-directory' };

/** Creates the provider-neutral working directory tool. */
const factory = defineTool({
  name: 'cwd',
  description,
  input,
  output,
  execute: (_sandbox, host, input): Promise<CwdOutput> =>
    execute(host.workspace, input),
});

export default factory;

/**
 * A refusal keeps the current directory and names why, so the model corrects
 * its own path instead of handling a thrown failure. A path that is absent, or
 * blank once trimmed, names no directory - the HTTP route reads such a value the
 * same way - so it reports the current one instead. A path that is given is
 * trimmed here, exactly as the route trims it, so one rule sees one spelling.
 */
const execute = async (
  workspace: Workspace,
  input: Input,
): Promise<CwdOutput> => {
  const path = input.path?.trim();

  if (path === undefined || path === '') {
    return { cwd: workspace.cwd(), status: 'reported' };
  }

  const change = await workspace.setCwd(path);

  return change.status === 'set'
    ? { cwd: change.cwd, status: 'set' }
    : { cwd: workspace.cwd(), status: 'refused', reason: change.status };
};
