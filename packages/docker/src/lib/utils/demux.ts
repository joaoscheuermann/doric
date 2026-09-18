import { DockerProtocolError } from '../classes/errors.js';

export type DemuxedOutput = {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

/** Demultiplexes Docker's non-TTY exec stream into stdout and stderr bytes. */
export const demuxDockerOutput = (stream: Uint8Array): DemuxedOutput => {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let offset = 0;

  while (offset < stream.byteLength) {
    if (offset + 8 > stream.byteLength) {
      throw new DockerProtocolError(
        'Docker exec stream ended inside a frame header',
      );
    }

    const channel = stream[offset];

    const size =
      stream[offset + 4] * 16_777_216 +
      stream[offset + 5] * 65_536 +
      stream[offset + 6] * 256 +
      stream[offset + 7];
    const start = offset + 8;
    const end = start + size;

    if (end > stream.byteLength) {
      throw new DockerProtocolError(
        'Docker exec stream ended inside a frame body',
      );
    }

    const chunk = stream.subarray(start, end);

    if (channel === 1) {
      stdout.push(chunk);
    } else if (channel === 2) {
      stderr.push(chunk);
    } else {
      throw new DockerProtocolError(
        `Unknown Docker exec stream channel: ${channel}`,
      );
    }

    offset = end;
  }

  return {
    stdout: concat(stdout),
    stderr: concat(stderr),
  };
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);

    offset += chunk.byteLength;
  }

  return output;
};
