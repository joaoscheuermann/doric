import {
  type JsonValue,
  type ProviderError,
  ProviderErrorObject,
  type ProviderFinished,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderStreamEvent,
} from 'llms';
import type { ToolCall } from 'tool';

import { AgentErrorObject } from './classes/agent-error.js';
import type {
  Agent,
  AgentOptions,
  AgentResponse,
  AgentRunOptions,
} from './types/agent.js';
import type { ToolCallRecord } from './types/tool-call-storage.js';
import {
  answeredTurn,
  isRetryable,
  notifyStructuredAttempt,
  notifyToolCallRepair,
  pause,
  pushIncompleteToolResults,
  refusalError,
  repairLimit,
  responseFromFinish,
  retryDelay,
  retryPolicy,
  type TurnGuard,
  toolCallCorrection,
  toolFailureEnvelope,
  toolResultEnvelope,
  truncatedError,
  turnGuard,
} from './utils/run.js';
import { runTools } from './utils/run-tools.js';
import { describeToolFailure } from './utils/serialize.js';
import {
  createStructuredOutputTool,
  nextStructuredOutputRepair,
  parseStructuredOutputTool,
  type StructuredOutputBaseline,
  type StructuredOutputRepair,
  type StructuredOutputTool,
  structuredOutputInstruction,
} from './utils/structured-output.js';

/** Creates an embeddable agent runtime from injected provider, tool, and message boundaries. */
export const createAgent = (options: AgentOptions): Agent => {
  /** One agent owns one mutable message history and therefore runs serially. */
  let running = false;
  const retry = retryPolicy(options.retry);
  const pendingCalls = new Set<string>();

  const acquire = (): void => {
    if (running) {
      throw new AgentErrorObject({
        code: 'concurrent_run',
        message: 'Agent instances do not support concurrent runs.',
      });
    }

    running = true;
  };

  const release = (): void => {
    for (const callId of pendingCalls) {
      pushToolResult(
        callId,
        'Tool call did not complete. Execution may have been interrupted.',
        'incomplete',
      );
    }
    running = false;
  };

  const buildRequest = async <Output = JsonValue>(
    runOptions: AgentRunOptions<Output>,
    outputTool?: StructuredOutputTool,
  ): Promise<ProviderRequest<Output>> => {
    /** Caller messages come first, so the definitions and history below see them. */
    for (const content of (await runOptions.beforeRequest?.()) ?? []) {
      options.messages.push({ role: 'user', content });
    }
    /** Executable definitions come from the caller-owned tool storage. */
    const definitions = options.tools.definitions();
    const prompt =
      typeof options.system === 'string'
        ? options.system
        : await options.system();

    /**
     * Keep the authored system prompt first. Tool-enabled structured runs add
     * one generated instruction that tells the model how to end the loop.
     */
    const system: readonly ProviderMessage[] = [
      ...(prompt.length > 0
        ? [{ role: 'system' as const, content: prompt }]
        : []),
      ...(outputTool === undefined
        ? []
        : [
            {
              role: 'system' as const,
              content: structuredOutputInstruction(outputTool.name),
            },
          ]),
    ];
    /** The terminal output definition is visible to the model but not executable. */
    const tools =
      outputTool === undefined
        ? definitions
        : [...definitions, outputTool.definition];
    return {
      model: options.model,
      messages: [...system, ...options.messages.list()],
      ...(tools.length > 0 ? { tools } : {}),
      ...(outputTool === undefined ? {} : { parallelToolCalls: false }),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.flags !== undefined ? { flags: options.flags } : {}),
      ...(runOptions.signal !== undefined ? { signal: runOptions.signal } : {}),
    };
  };

  const outputTool = <Output>(
    runOptions: AgentRunOptions<Output>,
  ): StructuredOutputTool | undefined => {
    const definitions = options.tools.definitions();

    /** Every structured run terminates through the same provider-neutral tool. */
    return runOptions.schema === undefined
      ? undefined
      : createStructuredOutputTool(
          options.provider.metadata.id,
          runOptions.schema,
          definitions,
        );
  };

  const pushToolResult = (
    callId: string,
    content: string,
    toolResultStatus?: 'incomplete',
  ): void => {
    /** Tool results retain the provider call ID for the next model turn. */
    options.messages.push({
      role: 'tool',
      toolCallId: callId,
      content,
      ...(toolResultStatus === undefined ? {} : { toolResultStatus }),
    });
    pendingCalls.delete(callId);
  };

  /** The cap for one tool's answer: the number itself, or the function's for that tool. */
  const toolResultCap = (
    maxChars: AgentRunOptions['maxToolResultChars'],
    toolName: string,
  ): number | undefined =>
    typeof maxChars === 'function' ? maxChars(toolName) : maxChars;

  const observedToolResult =
    (maxChars: AgentRunOptions['maxToolResultChars']) =>
    (record: ToolCallRecord): string => {
      const content = toolResultEnvelope(
        record,
        toolResultCap(maxChars, record.toolName),
      );
      pushToolResult(record.callId, content);
      return content;
    };

  /** A thrown handler answers its call with the failure, never a record. */
  const observedToolFailure =
    (maxChars: AgentRunOptions['maxToolResultChars']) =>
    (call: ToolCall, error: unknown): void => {
      pushToolResult(
        call.id,
        toolFailureEnvelope(
          describeToolFailure(error),
          toolResultCap(maxChars, call.name),
        ),
      );
    };

  /**
   * Hands the model the correction for a rejected turn as a user turn that
   * stays in the history. The request then never ends in that rejected
   * assistant turn (current models refuse a trailing assistant turn), and the
   * system prompt stays the same on every request, which keeps the provider's
   * cache and its reasoning bound to the conversation.
   */
  const pushCorrection = (correction: string): void => {
    options.messages.push({ role: 'user', content: correction });
  };

  /** Asks the provider for one finished turn, again when it failed retryably. */
  const completeTurn = async <Output>(
    request: ProviderRequest<Output>,
    signal?: AbortSignal,
  ): Promise<ProviderFinished<Output>> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await options.provider.complete(request);
      } catch (error) {
        if (attempt >= retry.retries || !isRetryable(error) || signal?.aborted)
          throw error;
        await pause(retryDelay(error, attempt, retry), signal);
      }
    }
  };

  /**
   * Streams one provider turn, asking again when it failed retryably before it
   * produced anything. The `response.started` and `usage` events of an attempt
   * are held until its first output, so a failed attempt leaves no trace; once
   * output flowed, a failure is the caller's and is never retried.
   */
  async function* streamTurn<Output>(
    request: ProviderRequest<Output>,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent<Output>> {
    for (let attempt = 0; ; attempt += 1) {
      const held: ProviderStreamEvent<Output>[] = [];
      let flowing = false;
      let failure: unknown;
      try {
        for await (const event of options.provider.stream(request)) {
          if (!flowing) {
            if (event.type === 'response.started' || event.type === 'usage') {
              held.push(event);
              continue;
            }
            if (
              event.type === 'error' &&
              attempt < retry.retries &&
              isRetryable(event.error) &&
              !signal?.aborted
            ) {
              failure = event.error;
              break;
            }
            flowing = true;
            yield* held.splice(0);
          }
          yield event;
        }
      } catch (error) {
        if (
          flowing ||
          attempt >= retry.retries ||
          !isRetryable(error) ||
          signal?.aborted
        ) {
          yield* held;
          throw error;
        }
        failure = error;
      }
      if (failure === undefined) {
        yield* held;
        return;
      }
      await pause(retryDelay(failure, attempt, retry), signal);
    }
  }

  const storeAssistant = (finish: ProviderFinished<unknown>): void => {
    /** Message storage preserves both semantic calls and opaque provider replay. */
    options.messages.push({
      role: 'assistant',
      content:
        finish.text.length > 0 ? finish.text : (finish.refusal ?? finish.text),
      ...(finish.toolCalls.length === 0 ? {} : { toolCalls: finish.toolCalls }),
      ...(finish.replay === undefined ? {} : { replay: finish.replay }),
    });
    for (const call of finish.toolCalls) pendingCalls.add(call.id);
  };

  /**
   * Stores the caller's steering messages as user turns and returns them. A run
   * with no turn left asks for none, so they stay with the caller.
   */
  const takeSteering = async <Output>(
    runOptions: AgentRunOptions<Output>,
    turns: TurnGuard,
  ): Promise<readonly string[]> => {
    if (runOptions.steering === undefined || !turns.available()) return [];
    runOptions.signal?.throwIfAborted();
    const inputs = await runOptions.steering();
    for (const content of inputs) {
      options.messages.push({ role: 'user', content });
    }
    return inputs;
  };

  /** Validates calls in order and stops at the first failure. */
  const validatedCalls = async (
    finish: ProviderFinished<unknown>,
  ): Promise<ToolCall[]> => {
    const calls: ToolCall[] = [];

    for (const call of options.tools.calls(finish)) {
      calls.push(await options.tools.validate(call));
    }

    return calls;
  };

  return {
    complete: async <Output = JsonValue>(
      input: string,
      runOptions: AgentRunOptions<Output> = {},
    ): Promise<AgentResponse<Output>> => {
      const turns = turnGuard(runOptions.maxTurns);
      acquire();

      try {
        /** The caller input starts the run-local conversation. */
        if (!runOptions.resume)
          options.messages.push({ role: 'user', content: input });
        /** Steering that waited for the run is read before its first turn. */
        await takeSteering(runOptions, turns);

        /** A resumed history that already holds its answer is finished. */
        const answered =
          runOptions.resume && runOptions.schema === undefined
            ? answeredTurn(options.messages.list())
            : undefined;
        if (answered !== undefined)
          return responseFromFinish(answered as ProviderFinished<Output>);

        /** This value remains stable across every provider turn in the run. */
        const terminal = outputTool(runOptions);
        const maxRepairs = repairLimit(runOptions.maxToolCallRepairs);
        let invalidSubmissions = 0;
        let structuredAttempts = 0;
        let baseline: StructuredOutputBaseline | undefined;

        while (true) {
          /** Ask the provider for either executable calls or the terminal result. */
          runOptions.signal?.throwIfAborted();
          turns.begin();
          const request = await buildRequest(runOptions, terminal);
          runOptions.signal?.throwIfAborted();
          const answer = await completeTurn(request, runOptions.signal);
          /** A refused turn runs none of its calls, even half-formed ones. */
          const finish =
            answer.finishReason === 'content_filter'
              ? { ...answer, toolCalls: [] }
              : answer;
          if (runOptions.signal?.aborted) {
            storeAssistant(finish);
            runOptions.signal.throwIfAborted();
          }

          if (finish.finishReason === 'content_filter') {
            storeAssistant(finish);
            throw refusalError(finish);
          }

          /** Intercept and validate the reserved terminal call before normal tools. */
          if (terminal !== undefined) {
            const submission = parseStructuredOutputTool<Output>(
              finish,
              terminal,
              baseline,
            );

            if (submission.type === 'invalid') {
              storeAssistant(finish);
              pushIncompleteToolResults(finish, pushToolResult);
              if (finish.finishReason === 'length')
                throw truncatedError(submission.error);
              let repair: StructuredOutputRepair;
              try {
                repair = nextStructuredOutputRepair(
                  terminal,
                  submission.error,
                  invalidSubmissions,
                  maxRepairs,
                  submission.baseline,
                );
              } catch (error) {
                structuredAttempts += 1;
                await notifyStructuredAttempt(runOptions, {
                  attempt: structuredAttempts,
                  runtimeAccepted: false,
                  feedbackSent: false,
                  ...(submission.error.data.diagnostic === undefined
                    ? {}
                    : { diagnostic: submission.error.data.diagnostic }),
                });
                throw error;
              }
              structuredAttempts += 1;
              await notifyStructuredAttempt(runOptions, {
                attempt: structuredAttempts,
                runtimeAccepted: false,
                feedbackSent: true,
                ...(submission.error.data.diagnostic === undefined
                  ? {}
                  : { diagnostic: submission.error.data.diagnostic }),
              });
              invalidSubmissions = repair.invalidSubmissions;
              baseline = submission.baseline;
              await notifyToolCallRepair(runOptions, {
                attempt: invalidSubmissions,
                maxAttempts: maxRepairs,
              });
              pushCorrection(repair.correction);
              continue;
            }

            if (submission.type === 'finished') {
              baseline = undefined;
              structuredAttempts += 1;
              await notifyStructuredAttempt(runOptions, {
                attempt: structuredAttempts,
                runtimeAccepted: true,
                feedbackSent: false,
              });
              /** Store the normalized tool-free finish as the final assistant message. */
              storeAssistant(submission.finish);
              runOptions.signal?.throwIfAborted();
              return responseFromFinish(submission.finish);
            }
          }

          /** Any ordinary tool turn ends a pending transactional repair. */
          baseline = undefined;

          /** Ordinary assistant turns remain available to later tool iterations. */
          storeAssistant(finish);

          if (finish.toolCalls.length === 0) {
            /** Steering that arrived during the answer continues the run. */
            if (
              terminal === undefined &&
              (await takeSteering(runOptions, turns)).length > 0
            )
              continue;
            return responseFromFinish(finish);
          }

          let calls: Awaited<ReturnType<typeof validatedCalls>>;
          try {
            calls = await validatedCalls(finish);
          } catch (error) {
            pushIncompleteToolResults(finish, pushToolResult);
            /** A call the output limit cut short is no call to correct. */
            if (finish.finishReason === 'length') throw truncatedError(error);
            if (invalidSubmissions >= maxRepairs) throw error;
            invalidSubmissions += 1;
            await notifyToolCallRepair(runOptions, {
              attempt: invalidSubmissions,
              maxAttempts: maxRepairs,
            });
            pushCorrection(toolCallCorrection);
            continue;
          }

          /** Tool results are appended before the loop requests the next turn. */
          for await (const event of runTools(
            options,
            calls,
            runOptions,
            observedToolResult(runOptions.maxToolResultChars),
            observedToolFailure(runOptions.maxToolResultChars),
          )) {
            void event;
          }

          /** A finished tool batch is the safe point to read steering. */
          await takeSteering(runOptions, turns);
        }
      } finally {
        release();
      }
    },

    stream: async function* <Output = JsonValue>(
      input: string,
      runOptions: AgentRunOptions<Output> = {},
    ) {
      const turns = turnGuard(runOptions.maxTurns);
      acquire();

      try {
        /** Streaming uses the same message and terminal-tool contract as complete. */
        if (!runOptions.resume)
          options.messages.push({ role: 'user', content: input });
        const terminal = outputTool(runOptions);
        const maxRepairs = repairLimit(runOptions.maxToolCallRepairs);
        let invalidSubmissions = 0;
        let structuredAttempts = 0;
        let baseline: StructuredOutputBaseline | undefined;
        yield {
          type: 'agent.started',
          model: options.model,
          input,
        } as const;
        /** Steering that waited for the run is read before its first turn. */
        for (const steered of await takeSteering(runOptions, turns)) {
          yield { type: 'agent.steered', input: steered } as const;
        }

        /** A resumed history that already holds its answer is finished. */
        const answered =
          runOptions.resume && terminal === undefined
            ? answeredTurn(options.messages.list())
            : undefined;
        if (answered !== undefined) {
          yield {
            type: 'agent.finished',
            response: responseFromFinish(answered as ProviderFinished<Output>),
          } as const;
          return;
        }

        while (true) {
          runOptions.signal?.throwIfAborted();
          let finish: ProviderFinished<Output> | undefined;
          /** The provider error the turn's stream ended on, when it did. */
          let failed: ProviderError | undefined;
          /** Whether the turn was rejected and its correction already stored. */
          let corrected = false;
          const buffered: ProviderStreamEvent<Output>[] = [];
          turns.begin();
          const request = await buildRequest(runOptions, terminal);

          runOptions.signal?.throwIfAborted();
          for await (const received of streamTurn(request, runOptions.signal)) {
            /** A refused turn runs none of its calls, even half-formed ones. */
            const event =
              received.type === 'response.finished' &&
              received.finish.finishReason === 'content_filter'
                ? { ...received, finish: { ...received.finish, toolCalls: [] } }
                : received;
            if (runOptions.signal?.aborted) {
              if (event.type === 'response.finished')
                storeAssistant(event.finish);
              runOptions.signal.throwIfAborted();
            }
            if (event.type === 'error') failed = event.error;
            if (event.type === 'response.finished') {
              /** Normalize a terminal call before exposing the finished event. */
              if (
                terminal !== undefined &&
                event.finish.finishReason !== 'content_filter'
              ) {
                const submission = parseStructuredOutputTool<Output>(
                  event.finish,
                  terminal,
                  baseline,
                );

                if (submission.type === 'invalid') {
                  storeAssistant(event.finish);
                  pushIncompleteToolResults(event.finish, pushToolResult);
                  if (event.finish.finishReason === 'length')
                    throw truncatedError(submission.error);
                  let repair: StructuredOutputRepair;
                  try {
                    repair = nextStructuredOutputRepair(
                      terminal,
                      submission.error,
                      invalidSubmissions,
                      maxRepairs,
                      submission.baseline,
                    );
                  } catch (error) {
                    structuredAttempts += 1;
                    await notifyStructuredAttempt(runOptions, {
                      attempt: structuredAttempts,
                      runtimeAccepted: false,
                      feedbackSent: false,
                      ...(submission.error.data.diagnostic === undefined
                        ? {}
                        : { diagnostic: submission.error.data.diagnostic }),
                    });
                    throw error;
                  }
                  structuredAttempts += 1;
                  await notifyStructuredAttempt(runOptions, {
                    attempt: structuredAttempts,
                    runtimeAccepted: false,
                    feedbackSent: true,
                    ...(submission.error.data.diagnostic === undefined
                      ? {}
                      : { diagnostic: submission.error.data.diagnostic }),
                  });
                  invalidSubmissions = repair.invalidSubmissions;
                  baseline = submission.baseline;
                  await notifyToolCallRepair(runOptions, {
                    attempt: invalidSubmissions,
                    maxAttempts: maxRepairs,
                  });
                  pushCorrection(repair.correction);
                  corrected = true;
                  finish = undefined;
                  break;
                }

                finish =
                  submission.type === 'finished'
                    ? submission.finish
                    : event.finish;
                if (submission.type === 'finished') {
                  baseline = undefined;
                  structuredAttempts += 1;
                  await notifyStructuredAttempt(runOptions, {
                    attempt: structuredAttempts,
                    runtimeAccepted: true,
                    feedbackSent: false,
                  });
                }
              } else {
                finish = event.finish;
              }

              storeAssistant(finish);
              runOptions.signal?.throwIfAborted();
              if (terminal === undefined) yield { ...event, finish };
              else buffered.push({ ...event, finish });
              runOptions.signal?.throwIfAborted();
              continue;
            }

            if (terminal === undefined) yield event;
            else buffered.push(event);
            runOptions.signal?.throwIfAborted();
          }

          runOptions.signal?.throwIfAborted();
          if (finish === undefined && corrected) continue;

          if (finish === undefined) {
            /** The provider's own failure is the run's, not a missing finish. */
            if (failed !== undefined) {
              for (const event of buffered) yield event;
              throw new ProviderErrorObject(failed);
            }
            throw new AgentErrorObject({
              code: 'missing_provider_finish',
              message:
                'Provider stream ended without a response.finished event.',
            });
          }

          if (finish.finishReason === 'content_filter') {
            for (const event of buffered) yield event;
            throw refusalError(finish);
          }

          /** Ordinary calls cannot inherit a prior structured repair baseline. */
          if (finish.toolCalls.length > 0) baseline = undefined;

          /** A normalized terminal finish has no calls and completes the stream. */
          let calls: Awaited<ReturnType<typeof validatedCalls>>;
          try {
            calls = await validatedCalls(finish);
          } catch (error) {
            pushIncompleteToolResults(finish, pushToolResult);
            /** A call the output limit cut short is no call to correct. */
            if (finish.finishReason === 'length') throw truncatedError(error);
            if (invalidSubmissions >= maxRepairs) throw error;
            invalidSubmissions += 1;
            await notifyToolCallRepair(runOptions, {
              attempt: invalidSubmissions,
              maxAttempts: maxRepairs,
            });
            pushCorrection(toolCallCorrection);
            continue;
          }

          for (const event of buffered) {
            yield event;
            runOptions.signal?.throwIfAborted();
          }

          if (calls.length === 0) {
            /** Steering that arrived during the answer continues the run. */
            const steered =
              terminal === undefined
                ? await takeSteering(runOptions, turns)
                : [];
            if (steered.length > 0) {
              for (const input of steered) {
                yield { type: 'agent.steered', input } as const;
              }
              continue;
            }
            const response = responseFromFinish(finish);
            yield {
              type: 'agent.finished',
              response,
            } as const;
            return;
          }

          for await (const event of runTools(
            options,
            calls,
            runOptions,
            observedToolResult(runOptions.maxToolResultChars),
            observedToolFailure(runOptions.maxToolResultChars),
          )) {
            yield event;
          }

          /** A finished tool batch is the safe point to read steering. */
          for (const input of await takeSteering(runOptions, turns)) {
            yield { type: 'agent.steered', input } as const;
          }
        }
      } finally {
        release();
      }
    },
  };
};
