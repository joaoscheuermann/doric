// Protovalidate violations as today's refusals (S60c, contract s60 §2.7, D4).

import { ContractError } from 'bundle/contracts';
import type { InvalidInputAnswer } from 'bundle/host';

/** One refusal: today's code and, when the route sends a fixed sentence, that sentence. */
export interface ViolationRefusal {
  readonly reason: string;
  /** Today's message; absent: protovalidate's message of the first violation (only `invalid_config`). */
  readonly message?: string;
}

/** How one method's violations read as today's refusals (D4). */
export interface MethodViolations {
  /** The route's path parameter: the request field (proto name) and its refusal (`invalid_<kind>_id`). */
  readonly path?: {
    readonly field: string;
    readonly refusal: ViolationRefusal;
  };
  /** Every other violation (body, query, message rules, a second path segment such as `prompt_id`). */
  readonly other: ViolationRefusal;
}

/** The path parameter `<kind>_id`, refused as `invalid_<kind>_id`. */
const idPath = (kind: string): MethodViolations['path'] & {} => ({
  field: `${kind}_id`,
  refusal: {
    reason: `invalid_${kind}_id`,
    message: `The ${kind} ID is invalid.`,
  },
});
const projectPath = idPath('project');
const threadPath = idPath('thread');
const credentialPath = idPath('credential');

/** A method whose route refuses only its path id: any violation reads as that refusal. */
const pathOnly = (path: MethodViolations['path'] & {}): MethodViolations => ({
  path,
  other: path.refusal,
});

const config = '/doric.api.config.v1.ConfigService';
const credentials = '/doric.api.credentials.v1.CredentialsService';
const providers = '/doric.api.providers.v1.ProvidersService';
const projects = '/doric.api.projects.v1.ProjectsService';
const threads = '/doric.api.threads.v1.ThreadsService';
const terminals = '/doric.api.terminals.v1.TerminalsService';

const credentialRefusal = {
  reason: 'invalid_credential',
  message: 'The credential does not match its kind.',
};
const projectRefusal = {
  reason: 'invalid_project',
  message: 'A Project name between 1 and 80 characters is required.',
};
const pageRefusal = { reason: 'invalid_page', message: 'The page is invalid.' };
const pathRefusal = {
  reason: 'invalid_project_path',
  message: 'The Project path is invalid.',
};
const queuedPromptRefusal = {
  reason: 'invalid_prompt',
  message: 'A promptId is required.',
};

/** The table, keyed `/<service typeName>/<method name>`; one entry per method of §3 whose route refuses input. */
export const apiViolations: Readonly<Record<string, MethodViolations>> = {
  [`${config}/PutConfig`]: { other: { reason: 'invalid_config' } },
  [`${credentials}/CreateCredential`]: { other: credentialRefusal },
  [`${credentials}/UpdateCredential`]: {
    path: credentialPath,
    other: credentialRefusal,
  },
  [`${credentials}/DeleteCredential`]: pathOnly(credentialPath),
  [`${providers}/ListModels`]: {
    other: {
      reason: 'invalid_provider',
      message: 'The provider values are invalid.',
    },
  },
  [`${projects}/CreateProject`]: { other: projectRefusal },
  [`${projects}/UpdateProject`]: { path: projectPath, other: projectRefusal },
  [`${projects}/ListProjects`]: { other: pageRefusal },
  [`${projects}/ListThreads`]: { path: projectPath, other: pageRefusal },
  [`${projects}/SetProjectColor`]: {
    path: projectPath,
    other: {
      reason: 'invalid_project_color',
      message: 'A Project color from the palette, or null, is required.',
    },
  },
  [`${projects}/CreateThread`]: {
    path: projectPath,
    other: {
      reason: 'invalid_thread',
      message:
        'A Thread name between 1 and 80 characters and optional parentThreadId are accepted.',
    },
  },
  ...Object.fromEntries(
    [
      'ListFiles',
      'GetTree',
      'ReadFile',
      'GetDiff',
      'ListChanges',
      'GetFileDiff',
    ].map((method) => [
      `${projects}/${method}`,
      { path: projectPath, other: pathRefusal },
    ]),
  ),
  ...Object.fromEntries(
    [
      'GetProject',
      'GetProjectSsh',
      'GetProjectResources',
      'TerminateProject',
      'DeleteProject',
    ].map((method) => [`${projects}/${method}`, pathOnly(projectPath)]),
  ),
  [`${threads}/UpdateThread`]: {
    path: threadPath,
    other: {
      reason: 'invalid_thread',
      message:
        'A Thread name, a working directory, an execution (providerId and model, with an optional effort), or a combination is required.',
    },
  },
  [`${threads}/CreateBranch`]: {
    path: threadPath,
    other: {
      reason: 'invalid_branch',
      message: 'An existing local branch name is required.',
    },
  },
  [`${threads}/Prompt`]: {
    path: threadPath,
    other: {
      reason: 'invalid_prompt',
      message: 'Only a non-empty prompt is accepted.',
    },
  },
  [`${threads}/Steer`]: {
    path: threadPath,
    other: {
      reason: 'invalid_steer',
      message: 'A non-empty prompt and the running promptId are required.',
    },
  },
  [`${threads}/Resume`]: {
    path: threadPath,
    other: { reason: 'invalid_resume', message: 'A promptId is required.' },
  },
  [`${threads}/Interrupt`]: {
    path: threadPath,
    other: { reason: 'invalid_interrupt', message: 'A promptId is required.' },
  },
  [`${threads}/Rewind`]: {
    path: threadPath,
    other: {
      reason: 'invalid_rewind',
      message: 'A prompt ID and a non-empty prompt are required.',
    },
  },
  [`${threads}/ListEvents`]: {
    path: threadPath,
    other: {
      reason: 'invalid_event_cursor',
      message: 'The event cursor is invalid.',
    },
  },
  [`${threads}/GetQueuedPrompt`]: {
    path: threadPath,
    other: queuedPromptRefusal,
  },
  [`${threads}/DeleteQueuedPrompt`]: {
    path: threadPath,
    other: queuedPromptRefusal,
  },
  [`${threads}/UpdateQueuedPrompt`]: {
    path: threadPath,
    other: {
      reason: 'invalid_prompt',
      message: 'A prompt ID, non-empty text and its revision are required.',
    },
  },
  ...Object.fromEntries(
    [
      'GetThread',
      'GetGit',
      'ListBranches',
      'Compact',
      'GetUsage',
      'GetQueue',
      'ResumeQueue',
      'TerminateThread',
      'DeleteThread',
    ].map((method) => [`${threads}/${method}`, pathOnly(threadPath)]),
  ),
  [`${threads}/CreateTerminal`]: {
    other: {
      reason: 'invalid_terminal',
      message: 'Invalid terminal dimensions.',
    },
  },
  [`${terminals}/GetTerminal`]: {
    other: { reason: 'invalid_cursor', message: 'Invalid output cursor.' },
  },
  [`${terminals}/SendInput`]: {
    other: { reason: 'invalid_input', message: 'Invalid terminal input.' },
  },
  [`${terminals}/Resize`]: {
    other: { reason: 'invalid_size', message: 'Invalid terminal dimensions.' },
  },
};

/**
 * `BundleDefinition.invalidInput` for the eight services: the path refusal when any violation's `field[0]` is the
 * method's path field, else the `other` refusal; as `ContractError(reason, message)`. `undefined` for a method without
 * an entry (keeps `invalid_input`). Pure; never throws.
 */
export const invalidApiInput: InvalidInputAnswer = (method, violations) => {
  const key = `/${method.parent.typeName}/${method.name}`;
  const entry = Object.hasOwn(apiViolations, key)
    ? apiViolations[key]
    : undefined;

  if (entry === undefined) return undefined;

  const { path } = entry;
  const refusal =
    path !== undefined &&
    violations.some((violation) => violation.field[0] === path.field)
      ? path.refusal
      : entry.other;

  return new ContractError(
    refusal.reason,
    refusal.message ?? violations[0]?.message ?? 'The request is invalid.',
  );
};
