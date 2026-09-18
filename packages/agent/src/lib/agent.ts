import type {
  JsonValue,
  ProviderFinished,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent,
} from 'llms';

import { AgentErrorObject } from './classes/agent-error.js';
import type {
  Agent,
  AgentOptions,
  AgentResponse,
  AgentRunOptions,
  AgentToolEvent,
} from './types/agent.js';
import type { ToolCallRecord } from './types/tool-call-storage.js';
import {
  notifyStructuredAttempt,
  notifyToolCallRepair,
  notifyToolEvent,
  pushIncompleteToolResults,
  repairLimit,
  responseFromFinish,
  toolCallCorrection,
  toolResultEnvelope,
} from './utils/run.js';
import { serializeToolResult } from './utils/serialize.js';
import {
  createStructuredOutputTool,
  nextStructuredOutputRepair,
  parseStructuredOutputTool,
  type StructuredOutputBaseline,
  structuredOutputInstruction,
  type StructuredOutputTool,
} from './utils/structured-output.js';

/** Creates an embeddable agent runtime from injected provider, tool, and message boundaries. */
export const createAgent = (options: AgentOptions): Agent => {
  /** One agent owns one mutable message history and therefore runs serially. */
  let running = false;

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
    running = false;
  };

  const turnGuard = (maxTurns: number | undefined): (() => void) => {
    if (
      maxTurns !== undefined &&
      (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)
    ) {
      throw new TypeError('Agent maxTurns must be a positive safe integer.');
    }

    let turns = 0;

    return (): void => {
      if (maxTurns !== undefined && turns >= maxTurns) {
        throw new AgentErrorObject({
          code: 'turn_limit_exceeded',
          message: `Agent exceeded its ${maxTurns}-turn limit.`,
        });
      }

      turns += 1;
    };
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
  };

  const pushObservedToolResult = (record: ToolCallRecord): string => {
    const content = toolResultEnvelope(record);

    pushToolResult(record.callId, content);

    return content;
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
  };

  const validatedCalls = (finish: ProviderFinished<unknown>) =>
    options.tools.calls(finish).map((call) => options.tools.validate(call));

  const runTools = async function* <Output>(
    calls: ReturnType<typeof validatedCalls>,
    runOptions: AgentRunOptions<Output>,
  ): AsyncGenerator<AgentToolEvent> {
    /** Execute provider-requested tools sequentially in provider order. */
    for (const call of calls) {
      const started = { type: 'tool.started' as const, call };

      await notifyToolEvent(runOptions, started);

      yield started;

      try {
        const result = await options.tools.execute(call);
        const output = serializeToolResult(result);
        const record = options.toolCalls.append(call, output);
        const content = pushObservedToolResult(record);

        const finished = {
          type: 'tool.finished' as const,
          call,
          result,
          content,
          record,
        };

        await notifyToolEvent(runOptions, finished);

        yield finished;
      } catch (error) {
        const failed = { type: 'tool.failed' as const, call, error };

        await notifyToolEvent(runOptions, failed);

        yield failed;

        throw error;
      }
    }
  };

  return {
    complete: async <Output = JsonValue>(
      input: string,
      runOptions: AgentRunOptions<Output> = {},
    ): Promise<AgentResponse<Output>> => {
      const beginTurn = turnGuard(runOptions.maxTurns);

      acquire();

      try {
        /** The caller input starts the run-local conversation. */
        options.messages.push({ role: 'user', content: input });

        /** This value remains stable across every provider turn in the run. */
        const terminal = outputTool(runOptions);
        const maxRepairs = repairLimit(runOptions.maxToolCallRepairs);
        let invalidSubmissions = 0;
        let structuredAttempts = 0;
        let correction: string | undefined;
        let baseline: StructuredOutputBaseline | undefined;

        while (true) {
          /** Ask the provider for either executable calls or the terminal result. */
          beginTurn();

          const request = buildRequest(runOptions, terminal, correction);

          correction = undefined;

          const finish = await options.provider.complete(request);

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

              let repair;

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

              return responseFromFinish(submission.finish);
            }
          }

          /** Any ordinary tool turn ends a pending transactional repair. */
          baseline = undefined;

          /** Ordinary assistant turns remain available to later tool iterations. */
          storeAssistant(finish);

          if (finish.toolCalls.length === 0) {
            return responseFromFinish(finish);
          }

          let calls: ReturnType<typeof validatedCalls>;

          try {
            calls = validatedCalls(finish);
          } catch (error) {
            pushIncompleteToolResults(finish, pushToolResult);

            if (invalidSubmissions >= maxRepairs) {
              throw error;
            }

            invalidSubmissions += 1;

            await notifyToolCallRepair(runOptions, {
              attempt: invalidSubmissions,
              maxAttempts: maxRepairs,
            });

            correction = toolCallCorrection;

            continue;
          }

          /** Tool results are appended before the loop requests the next turn. */
          for await (const event of runTools(calls, runOptions)) {
            void event;
          }
        }
      } finally {
        release();
      }
    },

    stream: async function* <Output = JsonValue>(
      input: string,
      runOptions: AgentRunOptions<Output> = {},
    ) {
      const beginTurn = turnGuard(runOptions.maxTurns);

      acquire();

      try {
        /** Streaming uses the same message and terminal-tool contract as complete. */
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

        while (true) {
          let finish: ProviderFinished<Output> | undefined;
          const buffered: ProviderStreamEvent<Output>[] = [];

          beginTurn();

          const request = buildRequest(runOptions, terminal, correction);

          correction = undefined;

          for await (const event of options.provider.stream(request)) {
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

                  let repair;

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

              if (terminal === undefined) {
                yield { ...event, finish };
              } else {
                buffered.push({ ...event, finish });
              }

              continue;
            }

            if (terminal === undefined) {
              yield event;
            } else {
              buffered.push(event);
            }
          }

          if (finish === undefined && correction !== undefined) {
            continue;
          }

          if (finish === undefined) {
            throw new AgentErrorObject({
              code: 'missing_provider_finish',
              message:
                'Provider stream ended without a response.finished event.',
            });
          }

          storeAssistant(finish);

          /** Ordinary calls cannot inherit a prior structured repair baseline. */
          if (finish.toolCalls.length > 0) {
            baseline = undefined;
          }

          /** A normalized terminal finish has no calls and completes the stream. */
          let calls: ReturnType<typeof validatedCalls>;

          try {
            calls = validatedCalls(finish);
          } catch (error) {
            pushIncompleteToolResults(finish, pushToolResult);

            if (invalidSubmissions >= maxRepairs) {
              throw error;
            }

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
          }

          if (calls.length === 0) {
            const response = responseFromFinish(finish);

            yield {
              type: 'agent.finished',
              response,
            } as const;

            return;
          }

          for await (const event of runTools(calls, runOptions)) {
            yield event;
          }
        }
      } finally {
        release();
      }
    },
  };
};
