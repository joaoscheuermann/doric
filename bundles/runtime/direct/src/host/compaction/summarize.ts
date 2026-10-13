import type { ProviderMessage } from 'llms';

/*
 * The summarizer backend (the contract's compaction-basic, one level down):
 * it turns the condensed span into one summary a future run can continue
 * from. The provider boundary is injected, so tests drive it with a fake;
 * the abort signal is forwarded on every call, so an aborted run tears the
 * in-flight summary down (the contract requires this of backends).
 */

/** The rendered transcript cap: the tail survives, the head is noted. */
const transcriptCapFactor = 8;

/** The system prompt the summarizer runs under (human-readable, HC-010). */
const summaryPrompt = [
  'You are writing a summary that replaces an older part of a working conversation.',
  '',
  'The conversation continues right after the part being condensed, so the summary is the only place this content survives. Write it for an expert agent resuming work with no other memory of the condensed span:',
  '',
  '- State the overall task and its current status.',
  '- Keep every concrete decision, constraint, and correction the conversation established.',
  '- Keep file paths, branch names, commands, and identifiers that the remaining work needs.',
  '- Keep every promise made or expected (things someone is waiting on), and any open question.',
  '- Absorb any earlier "[Context summary]" message in the span: its facts merge into yours.',
  '- Drop small talk, failed experiments, and anything already superseded.',
  '',
  'Write plain Markdown with short sections. Be specific; do not editorialize. Do not answer the conversation, do not continue it, do not add questions of your own: only condense what is there.',
].join('\n');

/** One conversation message, as the summarizer reads it. */
const line = (label: string, text: string): string =>
  `**${label}:**\n\n${text}`;

/** The span as a readable transcript: role-labeled blocks in order. */
export const renderSpan = (messages: readonly ProviderMessage[]): string => {
  const parts: string[] = [];
  for (const message of messages) {
    const content =
      typeof message.content === 'string'
        ? message.content
        : (message.content ?? [])
            .map((part) =>
              part.type === 'text' ? part.text : `[image: ${part.imageUrl}]`,
            )
            .join('\n');
    if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      parts.push(
        line(
          'Assistant',
          `${content}${calls.length > 0 ? `\n\nTool calls: ${calls.map((call) => `${call.name ?? 'tool'}(${call.id})`).join(', ')}` : ''}`,
        ),
      );
    } else if (message.role === 'tool') {
      parts.push(
        line(
          `Tool result for ${message.toolCallId ?? 'unknown call'}`,
          content,
        ),
      );
    } else {
      parts.push(line('User', content));
    }
  }
  return parts.join('\n\n---\n\n');
};

/** What the summarizer needs: the provider call and the summary's budget. */
export interface Summarizer {
  readonly summarize: (
    span: readonly ProviderMessage[],
    signal?: AbortSignal,
  ) => Promise<string>;
}

/** Builds the summarizer over an injected provider completion call. */
export const createSummarizer = (options: {
  /** One completion call: system prompt and transcript in, summary text out. */
  readonly complete: (
    input: { readonly system: string; readonly transcript: string },
    signal?: AbortSignal,
  ) => Promise<string>;
  /** The summary's character budget; longer output is cut at a paragraph. */
  readonly summaryMaxChars: number;
}): Summarizer => {
  const cap = options.summaryMaxChars * transcriptCapFactor;
  return {
    summarize: async (span, signal) => {
      const transcript = renderSpan(span);
      const trimmed =
        transcript.length > cap
          ? `[... ${transcript.length - cap} characters of the oldest conversation omitted ...]\n\n${transcript.slice(-cap)}`
          : transcript;
      const text = (
        await options.complete(
          { system: summaryPrompt, transcript: trimmed },
          signal,
        )
      ).trim();
      if (text.length === 0) {
        throw new Error('The summarizer returned an empty summary.');
      }
      return text.length > options.summaryMaxChars
        ? `${text.slice(0, options.summaryMaxChars).replace(/\n[^\n]*$/, '')}\n\n[summary truncated]`
        : text;
    },
  };
};
