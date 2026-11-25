// One conversation fence drawn by the renderer chunk's `ConversationFence`
// (conversation-openui.md D29) in the happy-dom window, over a services stub
// that records what the fence asks of `chat.send/v1`, `openui.programs/v1`
// and `openui.questions/v1`. Import `./dom.js` first.
//
// Slice S65b: `openui.programs/v1` and `openui.questions/v1` are host
// contracts, reached over Connect (spec `docs/designs/grpc-processes.md`,
// section 13, "The window from phase 3 to phase 5"): `use` of their generated
// descriptor is a client of a fake `HostClients` over `createRouterTransport`
// (`./connect.js`), each call with the scope of its `use` as
// `doric-scope-bin`. Its router serves them the way openui's host does: each
// request read as today's JSON (`decode`, the host codec), recorded with the
// scope it carried, handed to the test's answer in today's shapes, and the
// answer written as the proto response (`encode`). Their envelope
// `ref<T>()`s answer nothing but a refusal; `chat.send/v1` stays a client
// contract on the envelope.

import type { Services } from 'bundle/contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { decode, encode } from 'runtime/contracts';

import type {
  ChatFence,
  ChatFenceView,
} from '../../../src/client/chat-contract.js';
import { ConversationFence } from '../../../src/client/chunks/renderer.js';
import type {
  LayoutGraph,
  LayoutResult,
} from '../../../src/client/diagram/layout-types.js';
import {
  ProgramsService,
  ReportErrorsRequestSchema,
} from '../../../src/contracts/gen/doric/openui/programs/v1/programs_pb.js';
import {
  AnswerRequestSchema,
  AnswerResponseSchema,
  QuestionsService,
  StatusRequestSchema,
  StatusResponseSchema,
} from '../../../src/contracts/gen/doric/openui/questions/v1/questions_pb.js';
import type { ProgramRevision } from '../../../src/contracts/index.js';
import {
  connectFailure,
  fakeHostClients,
  type HostCall,
  isDescService,
  onEnvelope,
  scopeOf,
} from './connect.js';

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

/** A test's answer, a failure of it sent as the host's Connect error. */
const answered = async <T>(answer: () => Promise<T> | T): Promise<T> => {
  try {
    return await answer();
  } catch (error) {
    throw connectFailure(error);
  }
};

/**
 * A services stub answering by contract id, with the scope of each `use`:
 * `openui.programs/v1` and `openui.questions/v1` over Connect, `chat.send/v1`
 * on the envelope.
 */
export const fenceServices = (
  answers: FenceAnswers = {},
): {
  readonly services: Services;
  readonly calls: FenceCalls;
  /** Every Connect call the client part made to the host, in call order. */
  readonly hostCalls: readonly HostCall[];
} => {
  const calls: FenceCalls = { actions: [], reports: [], questions: [] };
  const host = fakeHostClients(
    (router) => {
      router.service(ProgramsService, {
        reportErrors: async (request, context) => {
          calls.reports.push({
            input: decode(ReportErrorsRequestSchema, request),
            scope: scopeOf(context),
          });
          return {};
        },
      });
      router.service(QuestionsService, {
        status: async (request, context) => {
          const input = decode(StatusRequestSchema, request);
          calls.questions.push({
            method: 'status',
            input,
            scope: scopeOf(context),
          });
          const state = await answered(() =>
            answers.status === undefined
              ? { state: 'pending' }
              : answers.status(input),
          );
          return encode(StatusResponseSchema, { questionState: state });
        },
        answer: async (request, context) => {
          const input = decode(AnswerRequestSchema, request);
          calls.questions.push({
            method: 'answer',
            input,
            scope: scopeOf(context),
          });
          const state = await answered(() =>
            answers.answer === undefined
              ? {
                  state: 'answered',
                  answers: (input as { answers: unknown }).answers,
                }
              : answers.answer(input),
          );
          return encode(AnswerResponseSchema, { questionState: state });
        },
      });
    },
    {
      'openui.programs/v1': { bundleId: 'openui', version: '1.1.0' },
      'openui.questions/v1': { bundleId: 'openui', version: '1.1.0' },
    },
  );
  const apis: Record<string, unknown> = {
    'chat.send/v1': {
      sendAction: async (input: unknown) => {
        calls.actions.push(input);
        return answers.sendAction === undefined
          ? { status: 'accepted' }
          : await answers.sendAction(input);
      },
    },
  };
  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: { readonly id?: string }, scope?: unknown) => {
      if (isDescService(contract))
        return host.hostClients
          .part('openui')
          .use(
            contract,
            scope === undefined
              ? undefined
              : { scope: scope as Readonly<Record<string, string>> },
          );
      const id = contract.id ?? '';
      // The host contracts are served over Connect (above).
      if (id === 'openui.programs/v1' || id === 'openui.questions/v1')
        return onEnvelope(id);
      return apis[id];
    },
    whenAvailable: () => ({ dispose: () => undefined }),
  } as unknown as Services;
  return { services, calls, hostCalls: host.calls };
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
  /** Passed to `ConversationFence` as is; absent uses the module's real loader. */
  readonly layout?: (graph: LayoutGraph) => Promise<LayoutResult>;
}

const element = (props: FenceProps) =>
  createElement(ConversationFence, {
    view: props.view,
    revision: props.revision,
    latest: props.latest ?? true,
    superseded: props.superseded ?? false,
    services: props.services,
    watchAnswers: props.watchAnswers ?? (() => () => undefined),
    layout: props.layout,
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
