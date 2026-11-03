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
 * A line the Project does not hold stays the text it is. For a model that
 * reads no images, every line becomes a note in its place that names the
 * image and says the model was not shown it, so the request never carries an
 * image the provider would refuse.
 */
const resolveMessage = async (
  message: ProviderMessage,
  read: AttachmentReader,
  readsImages: boolean,
): Promise<ProviderMessage> => {
  if (
    (message.role !== 'user' && message.role !== 'tool') ||
    typeof message.content !== 'string'
  )
    return message;
  const text = message.content;
  const references = attachmentReferences(text);
  if (references.length === 0) return message;
  if (!readsImages) return { ...message, content: withImageNotes(text) };

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

/** The text with every reference as a note that the model was not shown it. */
const withImageNotes = (text: string): string => {
  let noted = '';
  let cursor = 0;
  for (const reference of attachmentReferences(text)) {
    noted += `${text.slice(cursor, reference.start)}[Image: ${reference.name} (not shown: this model does not read images)]`;
    cursor = reference.end;
  }
  return noted + text.slice(cursor);
};

const resolveRequest = async <Request extends ProviderRequest<unknown>>(
  request: Request,
  read: AttachmentReader,
  readsImages: boolean,
): Promise<Request> => ({
  ...request,
  messages: await Promise.all(
    request.messages.map((message) =>
      resolveMessage(message, read, readsImages),
    ),
  ),
});

/**
 * The provider the run talks to, reading each request's attachments first.
 * Every attachment is read once per run, however many turns carry it. A run
 * whose model reads no images (`readsImages: false`) reads none and sends a
 * note in each image's place.
 */
export const withAttachments = (
  provider: LlmProvider,
  read: AttachmentReader,
  readsImages = true,
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
        await resolveRequest(request, cached, readsImages),
      )) as LlmProvider['complete'],
    stream: async function* (request: ProviderRequest<unknown>) {
      yield* provider.stream(
        await resolveRequest(request, cached, readsImages),
      );
    } as LlmProvider['stream'],
    embedding: (request) => provider.embedding(request),
    rerank: (request) => provider.rerank(request),
    models: (signal) => provider.models(signal),
    validateModel: (model, signal) => provider.validateModel(model, signal),
  };
};
