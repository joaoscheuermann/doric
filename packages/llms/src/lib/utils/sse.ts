import type { HttpStreamChunk } from '../types/http.js';

export type SseEvent = {
  readonly event?: string;
  readonly data: string;
  readonly done: boolean;
};

const decoder = new TextDecoder();

/** Parses server-sent events across arbitrary chunk boundaries. */
export async function* parseSseEvents(
  chunks: AsyncIterable<HttpStreamChunk>,
): AsyncIterable<SseEvent> {
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  const emit = (): SseEvent | undefined => {
    if (event === undefined && data.length === 0) {
      return undefined;
    }

    const body = data.join('\n');

    const parsed = {
      event,
      data: body,
      done: body.trim() === '[DONE]',
    };

    event = undefined;

    data = [];

    return parsed;
  };

  const processLine = (line: string): SseEvent | undefined => {
    if (line === '') {
      return emit();
    }

    if (line.startsWith(':')) {
      return undefined;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const raw = separator === -1 ? '' : line.slice(separator + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;

    if (field === 'event') {
      event = value;
    }

    if (field === 'data') {
      data = [...data, value];
    }

    return undefined;
  };

  for await (const chunk of chunks) {
    buffer +=
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });

    const lines = buffer.split(/\r?\n/);

    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const parsed = processLine(line);

      if (parsed !== undefined) {
        yield parsed;
      }
    }
  }

  buffer += decoder.decode();

  if (buffer !== '') {
    const parsed = processLine(buffer);

    if (parsed !== undefined) {
      yield parsed;
    }
  }

  const trailing = emit();

  if (trailing !== undefined) {
    yield trailing;
  }
}
