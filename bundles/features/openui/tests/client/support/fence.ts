// One conversation fence drawn by the renderer chunk's `ConversationFence`
// (conversation-openui.md D29) in the happy-dom window, over a services stub
// that records what the fence asks of `chat.send/v1`, `openui.programs/v1`
// and `openui.questions/v1`. Import `./dom.js` first.

import type { Services } from 'bundle/contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  ChatFence,
  ChatFenceView,
} from '../../../src/client/chat-contract.js';
import { ConversationFence } from '../../../src/client/chunks/renderer.js';
import type { ProgramRevision } from '../../../src/contracts/index.js';

export const projectId = 'project-1';
export const threadId = 'thread-1';

export interface FenceCalls {
  /** `chat.send/v1.sendAction` inputs, in order. */
  readonly actions: unknown[];
  /** `openui.programs/v1.reportErrors` inputs, with the scope of their `use`. */
  readonly reports: { readonly input: unknown; readonly scope: unknown }[];
  /** `openui.questions/v1` calls, with the scope of their `use`. */
  readonly questions: {
    readonly method: string;
    readonly input: unknown;
    readonly scope: unknown;
  }[];
}

export interface FenceAnswers {
  sendAction?: (input: unknown) => Promise<unknown>;
  status?: (input: unknown) => Promise<unknown>;
  answer?: (input: unknown) => Promise<unknown>;
}

/** A services stub answering by contract id, with the scope of each `use`. */
export const fenceServices = (
  answers: FenceAnswers = {},
): { readonly services: Services; readonly calls: FenceCalls } => {
  const calls: FenceCalls = { actions: [], reports: [], questions: [] };
  const apis = (scope: unknown): Record<string, unknown> => ({
    'chat.send/v1': {
      sendAction: async (input: unknown) => {
        calls.actions.push(input);
        return answers.sendAction === undefined
          ? { status: 'accepted' }
          : await answers.sendAction(input);
      },
    },
    'openui.programs/v1': {
      reportErrors: async (input: unknown) => {
        calls.reports.push({ input, scope });
      },
    },
    'openui.questions/v1': {
      status: async (input: unknown) => {
        calls.questions.push({ method: 'status', input, scope });
        return answers.status === undefined
          ? { state: 'pending' }
          : await answers.status(input);
      },
      answer: async (input: unknown) => {
        calls.questions.push({ method: 'answer', input, scope });
        return answers.answer === undefined
          ? {
              state: 'answered',
              answers: (input as { answers: unknown }).answers,
            }
          : await answers.answer(input);
      },
    },
  });
  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: { readonly id?: string }, scope?: unknown) =>
      apis(scope)[contract.id ?? ''],
    whenAvailable: () => ({ dispose: () => undefined }),
  } as unknown as Services;
  return { services, calls };
};

/** A fence of the chat, `openui-lang`, of prompt `promptId`. */
export const chatFence = (
  body: string,
  options: {
    readonly info?: string;
    readonly state?: ChatFence['state'];
    readonly promptId?: string;
    readonly index?: number;
  } = {},
): ChatFence => {
  const promptId = options.promptId ?? 'p1';
  const index = options.index ?? 0;
  return {
    key: `${promptId}/1/${index}`,
    projectId,
    threadId,
    promptId,
    turnSequence: 1,
    index,
    info: options.info ?? 'openui-lang tag',
    body,
    state: options.state ?? 'closed',
  };
};

/** A revision of a fence whose program is its body (revision 1). */
export const revisionOf = (
  fence: ChatFence,
  options: Partial<ProgramRevision> = {},
): ProgramRevision => ({
  key: fence.key,
  identity: 'tag',
  revision: 1,
  program: fence.body,
  complete: fence.state === 'closed',
  question: false,
  ...options,
});

export interface Mounted {
  readonly container: HTMLElement;
  readonly root: Root;
  /** Renders new props into the same root. */
  update(props: FenceProps): Promise<void>;
  unmount(): Promise<void>;
}

export interface FenceProps {
  readonly view: ChatFenceView;
  readonly revision: ProgramRevision;
  readonly latest?: boolean;
  readonly superseded?: boolean;
  readonly services: Services;
  readonly watchAnswers?: (target: unknown, listener: () => void) => () => void;
}

const element = (props: FenceProps) =>
  createElement(ConversationFence, {
    view: props.view,
    revision: props.revision,
    latest: props.latest ?? true,
    superseded: props.superseded ?? false,
    services: props.services,
    watchAnswers: props.watchAnswers ?? (() => () => undefined),
  });

/** Mounts `ConversationFence` with `props` in a new container of the document. */
export const mountFence = async (props: FenceProps): Promise<Mounted> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element(props));
  });
  return {
    container,
    root,
    update: async (next) => {
      await act(async () => {
        root.render(element(next));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
};

/** Clicks a button by its text, inside `act`. */
export const clickButton = async (
  container: HTMLElement,
  text: string,
): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined)
    throw new Error(`No button "${text}" in: ${container.textContent}`);
  await act(async () => {
    button.click();
  });
};
