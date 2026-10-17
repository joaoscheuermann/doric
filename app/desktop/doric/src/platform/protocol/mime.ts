import { extname } from 'node:path';

const types: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.html': 'text/html',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
};

/** The `content-type` of a served file, by extension. */
export const mimeOf = (path: string): string =>
  types[extname(path).toLowerCase()] ?? 'application/octet-stream';
