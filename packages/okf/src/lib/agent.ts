import type { LlmProvider, ReasoningEffort } from 'llms';

export type CompletionConfig = {
  readonly effort?: ReasoningEffort;
  readonly model: string;
  readonly provider: LlmProvider;
  readonly signal?: AbortSignal;
};

export type TextCompletionInput = CompletionConfig & {
  readonly input: string;
  readonly maxOutputTokens: number;
  readonly stage: string;
  readonly system: string;
};

const messages = (system: string, input: string) => [
  { role: 'system' as const, content: system },
  { role: 'user' as const, content: input },
];

/** Runs one text, tool-free completion and requires a non-empty result. */
export const completeText = async (
  input: TextCompletionInput,
): Promise<string> => {
  if (wasAborted(input.signal)) {
    throw sanitizedAbort();
  }

  try {
    const response = await input.provider.complete({
      model: input.model,
      messages: messages(input.system, input.input),
      effort: input.effort,
      temperature: 0,
      maxOutputTokens: input.maxOutputTokens,
      flags: { sensitiveOutput: true },
      signal: input.signal,
    });
    const result = response.text?.trim();

    if (wasAborted(input.signal)) {
      throw sanitizedAbort();
    }

    if (result) {
      return result;
    }
  } catch (error) {
    if (wasAborted(input.signal) || isAbortError(error)) {
      throw sanitizedAbort();
    }
  }

  throw new Error(`${input.stage} did not return valid text output`);
};

const wasAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  error.name === 'AbortError';

const sanitizedAbort = (): DOMException =>
  new DOMException('The operation was aborted.', 'AbortError');
