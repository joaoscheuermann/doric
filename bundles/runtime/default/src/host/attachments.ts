import type {
  LlmProvider,
  ProviderContentPart,
  ProviderMessage,
  ProviderRequest,
} from 'llms';
import {
  type AttachmentContent,
  attachmentReferences,
} from 'runtime/contracts';

/** Reads one attachment the prompt's Project holds; undefined when it holds none. */
export type AttachmentReader = (
  id: string,
) => Promise<AttachmentContent | undefined>;

/**
 * The history stays text: a reader's image is the reference line their prompt
 * carries, and a tool's is the line its result does. Only the request a model
 * reads turns each line the Project holds into the image itself, where the
 * line was, behind a short `[Image: name]` so the words around it can name it.
 * A line the Project does not hold stays the text it is.
 */
const resolveMessage = async (
  message: ProviderMessage,
  read: AttachmentReader,
): Promise<ProviderMessage> => {
  if (
    (message.role !== 'user' && message.role !== 'tool') ||
    typeof message.content !== 'string'
  )
    return message;
  const text = message.content;
  const references = attachmentReferences(text);
  if (references.length === 0) return message;

  const parts: ProviderContentPart[] = [];
  let pending = '';
  let cursor = 0;
  let resolved = false;
  for (const reference of references) {
    pending += text.slice(cursor, reference.start);
    cursor = reference.end;
    const content = await read(reference.id);
    if (content === undefined) {
      pending += text.slice(reference.start, reference.end);
      continue;
    }
    resolved = true;
    parts.push({ type: 'text', text: `${pending}[Image: ${content.name}]` });
    parts.push({
      type: 'image',
      imageUrl: `data:${content.mediaType};base64,${content.bytes}`,
    });
    pending = '';
  }
  pending += text.slice(cursor);
  if (!resolved) return message;
  if (pending !== '') parts.push({ type: 'text', text: pending });

  return { ...message, content: parts };
};

const resolveRequest = async <Request extends ProviderRequest<unknown>>(
  request: Request,
  read: AttachmentReader,
): Promise<Request> => ({
  ...request,
  messages: await Promise.all(
    request.messages.map((message) => resolveMessage(message, read)),
  ),
});

/**
 * The provider the run talks to, reading each request's attachments first.
 * Every attachment is read once per run, however many turns carry it.
 */
export const withAttachments = (
  provider: LlmProvider,
  read: AttachmentReader,
): LlmProvider => {
  const cache = new Map<string, Promise<AttachmentContent | undefined>>();
  const cached: AttachmentReader = (id) => {
    let content = cache.get(id);
    if (content === undefined) {
      content = read(id);
      cache.set(id, content);
    }
    return content;
  };

  return {
    get metadata() {
      return provider.metadata;
    },
    get capabilities() {
      return provider.capabilities;
    },
    complete: (async (request: ProviderRequest<unknown>) =>
      await provider.complete(
        await resolveRequest(request, cached),
      )) as LlmProvider['complete'],
    stream: async function* (request: ProviderRequest<unknown>) {
      yield* provider.stream(await resolveRequest(request, cached));
    } as LlmProvider['stream'],
    embedding: (request) => provider.embedding(request),
    rerank: (request) => provider.rerank(request),
    models: (signal) => provider.models(signal),
    validateModel: (model, signal) => provider.validateModel(model, signal),
  };
};
