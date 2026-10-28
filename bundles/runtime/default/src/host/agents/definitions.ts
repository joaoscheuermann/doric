import { basename, posix } from 'node:path';

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';
import {
  RuntimeLeaseV1,
  reasoningEfforts,
  spawnInstructionsMaxLength,
  type ThreadAgentSource,
} from 'runtime/contracts';

import {
  type AgentDefinition,
  type AgentSummary,
  agentNamePattern,
  DefaultAgentsV1,
  defaultAgentsMethods,
} from '../../contracts/index.js';
import { checkTemplate } from '../prompts/templates.js';
import { promptVariableNames } from '../prompts/variables.js';
import { currentCwd, frontmatterField, skillBody } from '../skills/sources.js';
import type { AgentFile } from './built-in.js';

/** The folder of workspace agents, relative to the Thread's working directory. */
const WORKSPACE_AGENTS_DIR = '.agents/agents';

/** The most `*.md` files one scan reads (the first ones the shell's sorted glob yields). */
const WORKSPACE_AGENTS_MAX_FILES = 64;

/** How much of each agent file the scan reads, in bytes (its frontmatter must fit). */
const WORKSPACE_AGENT_HEAD_BYTES = 4096;

/** How long the one scan command may run. */
const WORKSPACE_SCAN_TIMEOUT_MS = 5000;

/** An agent file's name: `<name>.md` with `<name>` matching `agentNamePattern`. */
const agentFileName = /^([a-z0-9][a-z0-9_-]{0,63})\.md$/u;

/**
 * Prints one record per regular `<dir>/*.md` (`$1` is the directory, never
 * quoted into the script): the base name, NUL, the size in bytes, NUL, the
 * file's first bytes, NUL; at most `WORKSPACE_AGENTS_MAX_FILES`, in the
 * glob's sorted order.
 */
const scanScript = `n=0
for f in "$1"/*.md; do
  [ -f "$f" ] || continue
  [ "$n" -lt ${WORKSPACE_AGENTS_MAX_FILES} ] || break
  n=$((n + 1))
  printf '%s\\0' "\${f##*/}"
  printf '%s\\0' "$(wc -c < "$f" | tr -d ' ')"
  head -c ${WORKSPACE_AGENT_HEAD_BYTES} "$f"
  printf '\\0'
done
exit 0`;

/** A checked definition, or why it is invalid. */
type Checked =
  | { readonly definition: AgentDefinition }
  | { readonly reason: string };

/** Why the instructions are not a template citing only prompt variables, or undefined. */
const templateProblem = (instructions: string): string | undefined => {
  try {
    checkTemplate(instructions, promptVariableNames, 'instructions');
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cited = /^Template "[^"]*" cites undeclared name "(.*)"\.$/u.exec(
      message,
    );
    if (cited !== null) {
      return `the instructions cite "${cited[1]}", which is not a prompt variable (${promptVariableNames.join(', ')}); to write literal mustache tags, switch delimiters with {{=<% %>=}}`;
    }
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : message
            .replace(/^Template "[^"]*"(?::\s*|\s+)/u, '')
            .replace(/\.$/u, '');
    return `the instructions are not a valid template: ${cause}`;
  }
};

/**
 * Checks one definition file of `size` bytes whose text (or first bytes) is
 * `text`, for the agent `name` from `source`. The template is checked only
 * when `whole` (the text is the whole file, the default).
 */
const checkDefinition = (
  name: string,
  source: ThreadAgentSource,
  text: string,
  size = Buffer.byteLength(text, 'utf8'),
  whole = true,
): Checked => {
  if (size > spawnInstructionsMaxLength) {
    return {
      reason: `the file is larger than ${spawnInstructionsMaxLength} bytes`,
    };
  }
  const description = frontmatterField(text, 'description');
  if (description === undefined) {
    return { reason: 'the frontmatter has no description' };
  }
  const model = frontmatterField(text, 'model');
  const effortValue = frontmatterField(text, 'effort');
  const effort = reasoningEfforts.find((value) => value === effortValue);
  if (effortValue !== undefined && effort === undefined) {
    return {
      reason: `effort "${effortValue}" is not one of ${reasoningEfforts.join(', ')}`,
    };
  }
  const instructions = skillBody(text);
  const problem = whole ? templateProblem(instructions) : undefined;
  if (problem !== undefined) return { reason: problem };
  return {
    definition: {
      name,
      description,
      source,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      instructions,
    },
  };
};

/** The definition without its instructions. */
const summaryOf = ({
  instructions: _,
  ...summary
}: AgentDefinition): AgentSummary => summary;

/**
 * Checks and parses the built-in files, in order (name = base name of `path`
 * without `.md`). Returns one `built-in` definition per file. Throws
 * `Error('Built-in agent "<path>" is invalid: <reason>.')` for the first
 * invalid file: a file name that is not `<name>.md` with a name matching
 * `agentNamePattern`, a name two files define, or any reason a workspace
 * definition can be invalid for. Pure.
 */
export const loadBuiltInAgents = (
  files: readonly AgentFile[],
): readonly AgentDefinition[] => {
  const definitions: AgentDefinition[] = [];
  for (const { path, text } of files) {
    const invalid = (reason: string): Error =>
      new Error(`Built-in agent "${path}" is invalid: ${reason}.`);
    const name = agentFileName.exec(basename(path))?.[1];
    if (name === undefined) {
      throw invalid(
        `its file name is not <name>.md with a name matching ${agentNamePattern.source}`,
      );
    }
    if (definitions.some((definition) => definition.name === name)) {
      throw invalid(`two files define "${name}"`);
    }
    const checked = checkDefinition(name, 'built-in', text);
    if ('reason' in checked) throw invalid(checked.reason);
    definitions.push(checked.definition);
  }
  return definitions;
};

/**
 * One file of `.agents/agents` whose name matches `agentNamePattern`.
 * `summary` is absent when invalid; an invalid entry still hides the
 * built-in of the same name.
 */
export interface ScannedAgent {
  readonly name: string;
  readonly summary?: AgentSummary;
}

const workspaceAgents = async (
  cwd: string,
  call: Call,
  services: Services,
): Promise<readonly ScannedAgent[]> => {
  const directory = posix.join(cwd, WORKSPACE_AGENTS_DIR);
  const { exitCode, stdout } = await services.use(RuntimeLeaseV1).exec(
    {
      cmd: ['sh', '-c', scanScript, 'sh', directory],
      timeoutMs: WORKSPACE_SCAN_TIMEOUT_MS,
    },
    call,
  );
  if (exitCode !== 0) return [];
  const fields = stdout.split('\0');
  const agents: ScannedAgent[] = [];
  for (let at = 0; at + 2 < fields.length; at += 3) {
    const name = agentFileName.exec(fields[at] ?? '')?.[1];
    if (name === undefined) continue;
    // An unreadable size counts as too large.
    const reported = Number(fields[at + 1]);
    const size = Number.isSafeInteger(reported) ? reported : Infinity;
    const checked = checkDefinition(
      name,
      'workspace',
      fields[at + 2] ?? '',
      size,
      size <= WORKSPACE_AGENT_HEAD_BYTES,
    );
    agents.push(
      'reason' in checked
        ? { name }
        : { name, summary: summaryOf(checked.definition) },
    );
  }
  return agents;
};

/**
 * The workspace agents of `cwd`: one `RuntimeLeaseV1.exec` under `call` of
 * `sh -c` over `<cwd>/.agents/agents` (a positional argument), at most 64
 * regular `*.md` files in sorted glob order, each with its size and first
 * 4096 bytes. Base names not matching `<name>.md` are ignored; a file larger
 * than 64 000 bytes is invalid; otherwise the definition rules apply to the
 * head, the template checked only when the head is the whole file. Scan
 * order. Never rejects: missing provider, rejection, non-zero or null exit,
 * timeout → [].
 */
export const readWorkspaceAgents = (
  cwd: string,
  call: Call,
  services: Services,
): Promise<readonly ScannedAgent[]> =>
  workspaceAgents(cwd, call, services).catch(() => []);

/**
 * The agents in effect: a workspace entry (valid or not) hides the built-in
 * of its name; built-ins not hidden in order, then valid workspace summaries
 * in scan order; names unique. Pure.
 */
export const effectiveAgents = (
  builtIn: readonly AgentSummary[],
  workspace: readonly ScannedAgent[],
): readonly AgentSummary[] => {
  const hidden = new Set(workspace.map(({ name }) => name));
  return [
    ...builtIn.filter(({ name }) => !hidden.has(name)),
    ...workspace.flatMap(({ summary }) =>
      summary === undefined ? [] : [summary],
    ),
  ];
};

/** The workspace agent `name` of `cwd`, read whole and checked again. */
const resolveWorkspaceAgent = async (
  name: string,
  cwd: string,
  call: Call,
  services: Services,
): Promise<AgentDefinition> => {
  const path = posix.join(cwd, WORKSPACE_AGENTS_DIR, `${name}.md`);
  const invalid = (reason: string): ContractError =>
    new ContractError(
      'invalid_definition',
      `Agent "${name}" is invalid: ${reason}.`,
      { name, path, reason },
    );
  let text: string;
  try {
    text = await services.use(RuntimeLeaseV1).readFile(path, call);
  } catch {
    throw invalid('the file cannot be read');
  }
  const checked = checkDefinition(name, 'workspace', text);
  if ('reason' in checked) throw invalid(checked.reason);
  return checked.definition;
};

/**
 * The `default.agents/v1` service over the loaded built-ins. No method is
 * exposed. `list` answers the built-ins only when the working directory is
 * unknown, else the agents in effect with the workspace scan. `resolve` makes
 * the same choice: a workspace agent is read whole from
 * `<cwd>/.agents/agents/<name>.md` and checked again (invalid or unreadable →
 * `invalid_definition`, even when a built-in of that name exists); a built-in
 * comes from `builtIn`; any other name fails as `not_found`.
 */
export const agentsService = (builtIn: readonly AgentDefinition[]) => {
  const builtInSummaries = builtIn.map(summaryOf);
  const scan = async (call: Call, services: Services) => {
    const cwd = await currentCwd(call, services);
    return cwd === undefined
      ? { workspace: [] }
      : { cwd, workspace: await readWorkspaceAgents(cwd, call, services) };
  };

  return defineService(DefaultAgentsV1, {
    list: defineMethod({
      ...defaultAgentsMethods.list,
      execute: async (_input, call, services) =>
        effectiveAgents(
          builtInSummaries,
          (await scan(call, services)).workspace,
        ),
    }),
    resolve: defineMethod({
      ...defaultAgentsMethods.resolve,
      execute: async ({ name }, call, services) => {
        const { cwd, workspace } = await scan(call, services);
        if (
          cwd !== undefined &&
          workspace.some((agent) => agent.name === name)
        ) {
          return resolveWorkspaceAgent(name, cwd, call, services);
        }
        const definition = builtIn.find((agent) => agent.name === name);
        if (definition !== undefined) return definition;
        const agents = effectiveAgents(builtInSummaries, workspace).map(
          (agent) => agent.name,
        );
        throw new ContractError(
          'not_found',
          `Agent "${name}" is not defined. ${
            agents.length === 0
              ? 'No agent is defined.'
              : `Defined agents: ${agents.join(', ')}.`
          }`,
          { name, agents },
        );
      },
    }),
  });
};
