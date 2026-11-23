import { ConnectError } from '@connectrpc/connect';
import { fromConnectError, type RegisteredTool } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { ProviderRequest, ProviderStreamEvent } from 'llms';
import type { HistoryPatch } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import {
  bundleServices,
  fakeThreadState,
  type HarnessOptions,
  runPrompt,
  seedHistory,
  skill,
} from './harness.js';
import type { FakeCall, SessionState } from './router.js';

/** Retries `assertion` until it passes or `timeoutMs` ran out (for calls a handler makes after its caller settled). */
export const eventually = async (
  assertion: () => void,
  timeoutMs = 2000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

/** One turn of a scripted model: a text answer, tool calls, or a failure. */
export interface Turn {
  readonly text?: string;
  readonly calls?: readonly {
    readonly name: string;
    readonly arguments: string;
  }[];
  /** Thrown after `response.started`. */
  readonly fail?: () => unknown;
  /** Yielded instead of the turn's answer. */
  readonly events?: readonly ProviderStreamEvent[];
  /** Runs when the turn's request arrives. */
  readonly before?: (request: ProviderRequest) => void | Promise<void>;
}

/**
 * A model that plays `turns` in order, one per request (the last one again past the end), recording every request.
 * Its events are already in the form the `models/v1` wire gives back (`provider` a string id, `replay: []`), so the
 * kernel and the routed runs of one script see the same events.
 */
export const scriptedModel = (turns: readonly Turn[]) => {
  const requests: ProviderRequest[] = [];
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      requests.push(request);
      const turn = turns[requests.length - 1] ?? turns.at(-1) ?? {};
      await turn.before?.(request);
      yield {
        type: 'response.started' as const,
        provider: 'provider',
        model: request.model,
      };
      if (turn.fail !== undefined) throw turn.fail();
      if (turn.events !== undefined) {
        yield* turn.events;
        return;
      }
      yield {
        type: 'response.finished' as const,
        finish:
          turn.calls === undefined
            ? {
                text: turn.text ?? 'done',
                finishReason: 'stop' as const,
                toolCalls: [],
                replay: [],
              }
            : {
                text: turn.text ?? '',
                finishReason: 'tool_calls' as const,
                toolCalls: turn.calls.map((call, index) => ({
                  id: `call-${index + 1}`,
                  ...call,
                })),
                replay: [],
              },
      };
    },
  };

  return { requests, provider };
};

/** The Doric error a failed call (or activation) carries, as `fromConnectError` reads it. */
export const failureOf = async (
  promise: Promise<unknown>,
): Promise<Error & { readonly code?: string; readonly details?: unknown }> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectError) return fromConnectError(error);
    if (error instanceof Error) return error;
    throw error;
  }

  throw new Error('Expected the call to fail.');
};

/** The history a previous run left, stored in the session fake as the kernel harness's `seedHistory` stores it. */
export const seedSession = (
  session: SessionState,
  value: Parameters<typeof seedHistory>[1],
): void => {
  seedHistory(
    {
      apply: (patch: HistoryPatch) => {
        session.format = patch.format;
        Object.assign(session.parts, structuredClone(patch.parts));
      },
    } as unknown as Parameters<typeof seedHistory>[0],
    value,
  );
};

/**
 * Today's kernel entry over the same scenario (the kernel harness): what a routed run must equal. `run` runs one
 * prompt; `state` holds what the kernel recorded.
 */
export const kernelOf = (options: HarnessOptions) => {
  const services = bundleServices(options);
  const state = fakeThreadState();
  let activated = false;
  const activate = () => {
    if (!activated) services.activate();
    activated = true;
  };

  return {
    services,
    state,
    activate,
    run: (prompt: string, run: Parameters<typeof runPrompt>[3] = {}) => {
      activate();
      return runPrompt(services, state, prompt, run);
    },
  };
};

/** The bundle whose services the kernel runs' in-process tools are bound to. */
const toolsOwner = createTestServices({ bundle: { id: 'tools-owner' } });

/**
 * A tool `tools/v1` lists to a kernel run, as `tools-owner` registered it: `name` (and `description`), no input,
 * answering what `execute` answers or throwing what it throws.
 */
export const kernelTool = (
  name: string,
  execute: (payload: unknown) => unknown = () => ({}),
  options: {
    readonly description?: string;
    readonly resultModalities?: readonly string[];
  } = {},
): RegisteredTool => ({
  bundleId: 'tools-owner',
  alwaysAvailable: false,
  tool: defineTool({
    name,
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.resultModalities === undefined
      ? {}
      : { resultModalities: [...options.resultModalities] }),
    input: z.object({}),
    output: z.unknown(),
    execute: async (payload) => execute(payload),
  }).bind(toolsOwner.services) as unknown as RegisteredTool['tool'],
});

/** The calls of `service` among `calls`. */
export const callsOf = (
  calls: readonly FakeCall[],
  service: { readonly typeName: string },
  method?: string,
): readonly FakeCall[] =>
  calls.filter(
    (call) =>
      call.service === service.typeName &&
      (method === undefined || call.method === method),
  );

export const skills = [skill('sandbox', 'Inspect before reporting.')];

/** The history a previous prompt left: one exchange and its boundary. */
export const earlier = {
  messages: [
    {
      role: 'user' as const,
      content: '<user-request>\nearlier\n</user-request>',
    },
    { role: 'assistant' as const, content: 'earlier answer' },
  ],
  checkpoints: { 'prompt-0': 0 },
};

/** A tool `tools/v1` lists, offered to the model and answering `{}`. */
export const inspect = { name: 'inspect', description: 'Inspect state.' };

/** A model that calls `inspect` once, then answers `answer`. */
export const usingTool = () =>
  scriptedModel([
    { calls: [{ name: 'inspect', arguments: '{}' }] },
    { text: 'answer' },
  ]);
