// What the footer execution picker's stories draw: literal views as
// `settings.models/v1` answers them, a fake of that contract, a selected
// Thread and a host that answers its writes. The rules that compute a view
// are `settings`' (tested there); a story only shows what the chat draws for
// one.

import type { Disposable } from 'bundle/contracts';
import type {
  RuntimeRecords,
  RuntimeThreads,
  Thread,
  ThreadExecutionResult,
} from 'runtime/contracts';
import type {
  EffortChoice,
  ExecutionView,
  ModelExecution,
  ModelGroup,
  SettingsModels,
} from 'settings/contracts';

import type { ExecutionPickerSources } from '../../src/client/components/organisms/execution-picker.js';

/** Two story icons, each with a unique `id`. */
const squareSvg =
  '<svg id="story-icon-square" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>';
const circleSvg =
  '<svg id="story-icon-circle" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';

const choice = (
  providerId: string,
  model: string,
  icon?: string,
  effort?: ModelExecution['effort'],
) => ({
  label: model,
  value: `${providerId}\u0000${model}`,
  ...(icon === undefined ? {} : { icon }),
  execution: {
    providerId,
    model,
    ...(effort === undefined ? {} : { effort }),
  },
});

/** OpenRouter's and LM Studio's models, under their provider's label. */
export const groups: readonly ModelGroup[] = [
  {
    label: 'openrouter',
    choices: [
      choice('openrouter', 'anthropic/claude-sonnet-4.5', squareSvg, 'medium'),
      choice('openrouter', 'deepseek/deepseek-v3.2', circleSvg),
      choice('openrouter', 'meta-llama/llama-4-maverick'),
    ],
  },
  {
    label: 'lmstudio',
    choices: [choice('lmstudio', 'qwen/qwen3-coder-30b')],
  },
];

const efforts = (execution: ModelExecution): readonly EffortChoice[] =>
  (['low', 'medium', 'high'] as const).map((value) => ({
    label: value.charAt(0).toUpperCase() + value.slice(1),
    value,
    ...(value === 'medium' ? { note: '(default)' } : {}),
    execution: { ...execution, effort: value },
  }));

const sonnet: ModelExecution = {
  providerId: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5',
  effort: 'medium',
};

/** A ready view of Claude Sonnet at medium effort, with its icon. */
export const readyView: ExecutionView = {
  status: 'ready',
  reloading: false,
  execution: sonnet,
  icon: squareSvg,
  value: `openrouter\u0000${sonnet.model}`,
  listsModels: true,
  groups,
  efforts: efforts(sonnet),
  effortLabel: 'Medium',
  typedProviderId: 'openrouter',
};

/** A model that lists no effort: the effort trigger reads "Unavailable". */
export const withoutReasoning: ExecutionView = {
  status: 'ready',
  reloading: false,
  execution: { providerId: 'openrouter', model: 'meta-llama/llama-4-maverick' },
  value: 'openrouter\u0000meta-llama/llama-4-maverick',
  listsModels: true,
  groups,
  efforts: [],
  effortLabel: 'Unavailable',
  typedProviderId: 'openrouter',
};

/** No provider lists a model: the model is typed by hand. */
export const typedView: ExecutionView = {
  status: 'ready',
  reloading: false,
  execution: { providerId: 'lmstudio', model: 'qwen3-coder' },
  value: 'lmstudio\u0000qwen3-coder',
  listsModels: false,
  groups: [],
  efforts: [],
  effortLabel: 'Unavailable',
  typedProviderId: 'lmstudio',
};

/** The configuration could not be read. */
export const failedView: ExecutionView = {
  status: 'loading',
  reloading: false,
  error: {
    code: 'config_read_failed',
    message: 'The request could not be completed.',
    causes: [],
  },
};

/** `settings.models/v1` answering `view` whatever the Thread stores. */
export const storyModels = (view: ExecutionView): SettingsModels => ({
  view: () => view,
  subscribe: (): Disposable => ({ dispose: () => undefined }),
  reload: () => undefined,
});

const thread: Thread = {
  id: 'story-thread',
  projectId: 'story-project',
  name: 'Story thread',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...sonnet,
} as Thread;

/**
 * The picker's sources over `view`: a selected Thread, and a host that answers
 * every write with `answer` (accepted by default).
 */
export const storySources = (
  view: ExecutionView,
  answer?: ThreadExecutionResult,
): ExecutionPickerSources => ({
  models: storyModels(view),
  selection: {
    current: () => ({ projectId: thread.projectId, threadId: thread.id }),
    subscribe: () => ({ dispose: () => undefined }),
  },
  records: {
    thread: (threadId) => (threadId === thread.id ? thread : undefined),
    subscribe: () => ({ dispose: () => undefined }),
  } satisfies Pick<RuntimeRecords, 'thread' | 'subscribe'>,
  setThreadExecution: ((input) =>
    Promise.resolve(
      answer ?? { status: 'updated', thread: { ...thread, ...input } },
    )) satisfies RuntimeThreads['setThreadExecution'],
});
