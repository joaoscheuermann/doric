import type { ProviderMessage } from 'llms';

import { estimatedTokens } from './rewrite.js';

/*
 * The trigger's measurement (the contract's token meter, folded into one
 * projection): how large the next provider call projects to be, against the
 * window the last response reported. Real usage is a measurement; the next
 * prompt and everything else here is an estimate, and the projection says so.
 */

/** What the last responses reported and the pending prompt contributes. */
export interface ProjectionInput {
  /** The history the next request would carry, without the system prompt. */
  readonly messages: readonly ProviderMessage[];
  /** The pending prompt text, or empty when the run is between turns. */
  readonly promptChars: number;
  /** The last response's reported input tokens, when one exists. */
  readonly lastInputTokens?: number;
  /** The last response's reported output tokens, when one exists. */
  readonly lastOutputTokens?: number;
  /** The window the provider reported (event) or the catalog knows. */
  readonly contextWindow?: number;
  /** The character budget the projection falls back to without a window. */
  readonly charBudget: number;
  /** The pressure fraction (percent) that turns the projection true. */
  readonly pressurePercent: number;
}

/** The projection the trigger reads: whether pressure exists, and why. */
export interface Projection {
  readonly underPressure: boolean;
  readonly contextWindow?: number;
  readonly projectedTokens?: number;
  readonly estimatedTokens: number;
}

/** The history's character size, as the fallback projection reads it. */
export const historyChars = (messages: readonly ProviderMessage[]): number =>
  messages.reduce((total, message) => {
    const content = message.content;
    if (typeof content === 'string') return total + content.length;
    if (content === undefined) return total;
    return (
      total +
      content.reduce(
        (sum, part) =>
          sum +
          (part.type === 'text' ? part.text.length : part.imageUrl.length),
        0,
      )
    );
  }, 0);

/**
 * The projection of the next call: real input/output tokens when the last
 * response reported them, the pending prompt estimated, and pressure against
 * the window — or, without a known window, the character budget instead.
 */
export const projection = (input: ProjectionInput): Projection => {
  const promptTokens = estimatedTokens(input.promptChars);
  const lastInput =
    input.lastInputTokens ?? estimatedTokens(historyChars(input.messages));
  const lastOutput = input.lastOutputTokens ?? 0;
  const projected = lastInput + lastOutput + promptTokens;
  if (input.contextWindow === undefined || input.contextWindow <= 0) {
    const estimated =
      estimatedTokens(historyChars(input.messages)) + promptTokens;
    return {
      underPressure:
        estimated >= input.charBudget * (input.pressurePercent / 100),
      estimatedTokens: estimated,
    };
  }
  return {
    underPressure:
      projected >= input.contextWindow * (input.pressurePercent / 100),
    contextWindow: input.contextWindow,
    projectedTokens: projected,
    estimatedTokens: lastInput + lastOutput,
  };
};

/**
 * Whether one provider error reads as a context-window overflow. A
 * documented heuristic over the provider's message: every known provider
 * names the context window differently, so the match is textual and may
 * miss providers with other wording — a missed match fails the run as it
 * does today, no worse.
 */
export const isContextOverflow = (message: string): boolean =>
  /context[ _](window|length|overflow)|too many tokens|maximum context|input tokens exceed|prompt is too long/i.test(
    message,
  );

/** The strings a provider failure names itself by: message, code, diagnostic. */
const failureTexts = (failure: unknown): readonly string[] => {
  if (typeof failure !== 'object' || failure === null) return [String(failure)];
  const texts: string[] = [];
  const read = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const key of ['message', 'code', 'diagnostic'] as const) {
      const text = (value as Record<string, unknown>)[key];
      if (typeof text === 'string') texts.push(text);
    }
  };
  read(failure);
  read((failure as { readonly data?: unknown }).data);
  return texts;
};

/**
 * Whether a thrown provider error, or the `error` a stream event carries,
 * reads as a context-window overflow. Its message, code and diagnostic are
 * all read: a provider may report the overflow in its body excerpt alone
 * (`diagnostic`) under a generic HTTP message.
 */
export const isContextOverflowError = (failure: unknown): boolean =>
  failureTexts(failure).some(isContextOverflow);
