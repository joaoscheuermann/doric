import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { JsonlFile, JsonlValue } from './types/jsonl.js';
import { parseLine, serializeLine } from './utils/line.js';

export { JsonlParseError } from './classes/parse-error.js';

export type {
  JsonlArray,
  JsonlFile,
  JsonlObject,
  JsonlPrimitive,
  JsonlValue,
} from './types/jsonl.js';

type JsonlState = {
  readonly path: string;
  pending: Promise<void>;
  stream: WriteStream | undefined;
};

/** Creates a stream-backed JSONL file handle for appending and reading records. */
export function jsonl(path: string): JsonlFile {
  const state: JsonlState = {
    path,
    pending: Promise.resolve(),
    stream: undefined,
  };

  return {
    path,

    append(value: JsonlValue): Promise<void> {
      return append(state, value);
    },

    read(): AsyncIterable<JsonlValue> {
      return read(state.path);
    },

    close(): Promise<void> {
      return close(state);
    },
  };
}

function append(state: JsonlState, value: JsonlValue): Promise<void> {
  const line = serializeLine(value);

  const writeLine = state.pending
    .catch(() => undefined)
    .then(() => write(state, line));

  state.pending = writeLine;

  return writeLine;
}

async function* read(path: string): AsyncIterable<JsonlValue> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;

      yield parseLine(path, lineNumber, line);
    }
  } finally {
    lines.close();

    input.destroy();
  }
}

async function close(state: JsonlState): Promise<void> {
  await state.pending;

  const output = state.stream;

  if (output === undefined || output.destroyed) {
    state.stream = undefined;

    return;
  }

  state.stream = undefined;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      output.off('error', onError);

      output.off('finish', onFinish);
    };

    const onError = (error: Error) => {
      cleanup();

      reject(error);
    };

    const onFinish = () => {
      cleanup();

      resolve();
    };

    output.once('error', onError);

    output.once('finish', onFinish);

    output.end();
  });
}

function open(state: JsonlState): WriteStream {
  if (state.stream === undefined || state.stream.destroyed) {
    state.stream = createWriteStream(state.path, {
      encoding: 'utf8',
      flags: 'a',
    });
  }

  return state.stream;
}

async function write(state: JsonlState, line: string): Promise<void> {
  const output = open(state);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      output.off('error', onError);
    };

    const onError = (error: Error) => {
      cleanup();

      state.stream = undefined;

      reject(error);
    };

    output.once('error', onError);

    output.write(line, (error: Error | null | undefined) => {
      cleanup();

      if (error !== null && error !== undefined) {
        state.stream = undefined;

        reject(error);

        return;
      }

      resolve();
    });
  });
}
