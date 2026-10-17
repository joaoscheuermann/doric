import type {
  JsonValue,
  ProviderFinished,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent,
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
  notifyStructuredAttempt,
  notifyToolCallRepair,
  pushIncompleteToolResults,
  repairLimit,
  responseFromFinish,
  type TurnGuard,
  toolCallCorrection,
  toolFailureEnvelope,
  toolResultEnvelope,
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

  const buildRequest = <Output = JsonValue>(
    runOptions: AgentRunOptions<Output>,
    outputTool?: StructuredOutputTool,
    correction?: string,
  ): ProviderRequest<Output> => {
    /** Executable definitions come from the caller-owned tool storage. */
    const definitions = options.tools.definitions();

    /**
     * Keep the authored system prompt first. Tool-enabled structured runs add
     * one generated instruction that tells the model how to end the loop.
     */
    const system: readonly ProviderMessage[] = [
      ...(options.system.length > 0
        ? [{ role: 'system' as const, content: options.system }]
        : []),
      ...(outputTool === undefined
        ? []
        : [
            {
              role: 'system' as const,
              content: structuredOutputInstruction(outputTool.name),
            },
          ]),
      ...(correction === undefined
        ? []
        : [{ role: 'system' as const, content: correction }]),
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

  const observedToolResult =
    (maxChars?: number) =>
    (record: ToolCallRecord): string => {
      const content = toolResultEnvelope(record, maxChars);
      pushToolResult(record.callId, content);
      return content;
    };

  /** A thrown handler answers its call with the failure, never a record. */
  const observedToolFailure =
    (maxChars?: number) =>
    (call: ToolCall, error: unknown): void => {
      pushToolResult(
        call.id,
        toolFailureEnvelope(describeToolFailure(error), maxChars),
      );
    };

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
        /** A resumed run reads steering that waited for it before its first turn. */ else
          await takeSteering(runOptions, turns);

        /** This value remains stable across every provider turn in the run. */
        const terminal = outputTool(runOptions);
        const maxRepairs = repairLimit(runOptions.maxToolCallRepairs);
        let invalidSubmissions = 0;
        let structuredAttempts = 0;
        let correction: string | undefined;
        let baseline: StructuredOutputBaseline | undefined;

        while (true) {
          /** Ask the provider for either executable calls or the terminal result. */
          runOptions.signal?.throwIfAborted();
          turns.begin();
          const request = buildRequest(runOptions, terminal, correction);
          correction = undefined;
          runOptions.signal?.throwIfAborted();
          const finish = await options.provider.complete(request);
          if (runOptions.signal?.aborted) {
            storeAssistant(finish);
            runOptions.signal.throwIfAborted();
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
              correction = repair.correction;
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
            if (invalidSubmissions >= maxRepairs) throw error;
            invalidSubmissions += 1;
            await notifyToolCallRepair(runOptions, {
              attempt: invalidSubmissions,
              maxAttempts: maxRepairs,
            });
            correction = toolCallCorrection;
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
        let correction: string | undefined;
        let baseline: StructuredOutputBaseline | undefined;
        yield {
          type: 'agent.started',
          model: options.model,
          input,
        } as const;
        /** A resumed run reads steering that waited for it before its first turn. */
        if (runOptions.resume) {
          for (const steered of await takeSteering(runOptions, turns)) {
            yield { type: 'agent.steered', input: steered } as const;
          }
        }

        while (true) {
          runOptions.signal?.throwIfAborted();
          let finish: ProviderFinished<Output> | undefined;
          const buffered: ProviderStreamEvent<Output>[] = [];
          turns.begin();
          const request = buildRequest(runOptions, terminal, correction);
          correction = undefined;

          runOptions.signal?.throwIfAborted();
          for await (const event of options.provider.stream(request)) {
            if (runOptions.signal?.aborted) {
              if (event.type === 'response.finished')
                storeAssistant(event.finish);
              runOptions.signal.throwIfAborted();
            }
            if (event.type === 'response.finished') {
              /** Normalize a terminal call before exposing the finished event. */
              if (terminal !== undefined) {
                const submission = parseStructuredOutputTool<Output>(
                  event.finish,
                  terminal,
                  baseline,
                );

                if (submission.type === 'invalid') {
                  storeAssistant(event.finish);
                  pushIncompleteToolResults(event.finish, pushToolResult);
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
                  correction = repair.correction;
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
          if (finish === undefined && correction !== undefined) continue;

          if (finish === undefined) {
            throw new AgentErrorObject({
              code: 'missing_provider_finish',
              message:
                'Provider stream ended without a response.finished event.',
            });
          }

          /** Ordinary calls cannot inherit a prior structured repair baseline. */
          if (finish.toolCalls.length > 0) baseline = undefined;

          /** A normalized terminal finish has no calls and completes the stream. */
          let calls: Awaited<ReturnType<typeof validatedCalls>>;
          try {
            calls = await validatedCalls(finish);
          } catch (error) {
            pushIncompleteToolResults(finish, pushToolResult);
            if (invalidSubmissions >= maxRepairs) throw error;
            invalidSubmissions += 1;
            await notifyToolCallRepair(runOptions, {
              attempt: invalidSubmissions,
              maxAttempts: maxRepairs,
            });
            correction = toolCallCorrection;
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
