import { Buffer } from 'node:buffer';

const block = 512;

export const packFile = (name: string, data: Uint8Array): Uint8Array => {
  const header = new Uint8Array(block);
  const padding = (block - (data.byteLength % block)) % block;
  const output = new Uint8Array(block + data.byteLength + padding + block * 2);

  text(header, 0, 100, name);

  octal(header, 100, 8, 0o644);

  octal(header, 108, 8, 0);

  octal(header, 116, 8, 0);

  octal(header, 124, 12, data.byteLength);

  octal(header, 136, 12, 0);

  header.fill(32, 148, 156);

  header[156] = 48;

  text(header, 257, 6, 'ustar');

  text(header, 263, 2, '00');

  const sum = header.reduce((total, byte) => total + byte, 0);

  text(header, 148, 6, sum.toString(8).padStart(6, '0'));

  header[154] = 0;

  header[155] = 32;

  output.set(header);

  output.set(data, block);

  return output;
};

export const extractFirstFile = (
  archive: Uint8Array,
): { readonly data: Uint8Array } => {
  let offset = 0;

  while (offset + block <= archive.byteLength) {
    const header = archive.subarray(offset, offset + block);

    if (header.every((byte) => byte === 0)) {
      break;
    }

    const size = Number.parseInt(read(header, 124, 12).trim() || '0', 8);
    const start = offset + block;
    const end = start + size;
    const kind = header[156];

    if (end > archive.byteLength) {
      throw new Error('Tar entry extends past archive end');
    }

    if (kind === 0 || kind === 48) {
      return { data: archive.slice(start, end) };
    }

    offset = end + ((block - (size % block)) % block);
  }

  throw new Error('Archive did not contain a regular file');
};

const text = (
  output: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void => {
  output.set(Buffer.from(value).subarray(0, length), offset);
};

const octal = (
  output: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void => {
  text(output, offset, length - 1, value.toString(8).padStart(length - 1, '0'));
};

const read = (input: Uint8Array, offset: number, length: number): string =>
  Buffer.from(input.subarray(offset, offset + length))
    .toString('utf8')
    .replace(/\0.*$/u, '');
