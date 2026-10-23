import type {
  ProviderImagePart,
  ProviderMessage,
  ProviderRequest,
} from '../../types/provider.js';
import { messageImages, messageText, requireRequestInput } from '../common.js';
import {
  messagesWithStructuredSchema,
  structuredJsonSchema,
} from '../structured.js';

/** The system line a Claude Code request carries when the caller sends none. */
export const claudeDefaultInstructions =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** The default cap a Claude Messages request sends: Anthropic requires one. */
const DEFAULT_MAX_TOKENS = 32000;

/**
 * A request as an Anthropic Messages body: system lines as the `system`
 * field, history as Messages messages, tool results as `tool_result`
 * blocks, and never a reasoning or structured-output control. Structured
 * output travels as a schema prompt when the flag asks for it, because
 * Claude's Messages API answers plain JSON without one.
 */
export const claudeBody = (
  request: ProviderRequest<unknown>,
  stream: boolean,
  provider = 'claude',
): Record<string, unknown> => {
  requireRequestInput(provider, request);
  const schema = structuredJsonSchema(provider, request.schema);
  const messages = messagesWithStructuredSchema(provider, request, schema);
  const system = messages
    .filter((message) => message.role === 'system')
    .map(messageText)
    .filter((text) => text !== '')
    .join('\n\n');
  const nonSystem = messages.filter((message) => message.role !== 'system');

  return prune({
    model: request.model,
    system: system === '' ? claudeDefaultInstructions : system,
    messages: claudeMessages(nonSystem),
    tools: request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
    tool_choice: toolChoice(request.toolChoice),
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    temperature: request.temperature,
    stream,
  });
};

/**
 * The history as Messages messages. A run of tool messages becomes one user
 * message of `tool_result` blocks, because Anthropic accepts tool results
 * only as user content.
 */
const claudeMessages = (
  messages: readonly ProviderMessage[],
): readonly Record<string, unknown>[] => {
  const result: Record<string, unknown>[] = [];
  let returned: Record<string, unknown>[] = [];

  const flush = () => {
    if (returned.length === 0) return;
    result.push({ role: 'user', content: returned });
    returned = [];
  };

  for (const message of messages) {
    if (message.role !== 'tool') {
      flush();
      result.push(claudeMessage(message));
      continue;
    }

    returned.push({
      type: 'tool_result',
      tool_use_id: message.toolCallId ?? '',
      content: messageText(message),
      ...(message.toolResultStatus === 'incomplete'
        ? { status: 'incomplete' as const }
        : {}),
    });
  }

  flush();

  return result;
};

/** One message as a Messages message: user content as blocks, assistant as text and tool_use. */
const claudeMessage = (message: ProviderMessage): Record<string, unknown> => ({
  role: message.role,
  content:
    message.role === 'assistant'
      ? assistantContent(message)
      : userContent(message),
});

/** A user message as content blocks, text parts and image sources in order. */
const userContent = (
  message: ProviderMessage,
): readonly Record<string, unknown>[] => {
  if (
    typeof message.content === 'string' ||
    message.content === undefined ||
    messageImages(message).length === 0
  ) {
    return [{ type: 'text', text: messageText(message) }];
  }

  return (message.content ?? []).map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: imageSource(part) },
  );
};

/** An assistant message as a text block beside its `tool_use` blocks. */
const assistantContent = (
  message: ProviderMessage,
): readonly Record<string, unknown>[] => {
  const text = messageText(message);
  const blocks: Record<string, unknown>[] =
    text !== '' ? [{ type: 'text', text }] : [];

  for (const call of message.toolCalls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: toolInput(call.arguments),
    });
  }

  // Anthropic rejects an empty content list, so a block-less turn still
  // carries its own text.
  return blocks.length === 0 ? [{ type: 'text', text }] : blocks;
};

/** The arguments a `tool_use` block sends, as the object the call's string parsed to. */
const toolInput = (arguments_: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(arguments_) as unknown;

    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** An image part as an Anthropic source: inline base64 data, or a URL the API fetches. */
const imageSource = (part: ProviderImagePart): Record<string, unknown> => {
  const url = part.imageUrl;
  const marker = ';base64,';

  if (url.startsWith('data:')) {
    const separator = url.indexOf(marker);

    if (separator !== -1) {
      return {
        type: 'base64',
        media_type: url.slice('data:'.length, separator),
        data: url.slice(separator + marker.length),
      };
    }
  }

  return { type: 'url', url };
};

/** A provider tool choice as Anthropic's: `required` is spelled `any`, a tool is named. */
const toolChoice = (
  choice: ProviderRequest<unknown>['toolChoice'],
): string | Record<string, unknown> | undefined => {
  if (choice === undefined) return undefined;

  if (typeof choice === 'object') {
    return { type: 'tool', name: choice.name };
  }

  return choice === 'required' ? 'any' : choice;
};

const prune = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
