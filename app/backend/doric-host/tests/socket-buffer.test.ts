// T2.3 (AC2.4): the host's Socket.IO buffer is a fixed constant of its own,
// so the kernel no longer imports `runtime/contracts` for it. The constant
// must still admit the largest attachment, encoded as base64, plus the
// message envelope around it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ATTACHMENT_MAX_BYTES } from 'runtime/contracts';

import { SOCKET_MAX_HTTP_BUFFER_BYTES } from '../src/lib/socket-buffer.js';

const ENVELOPE_ALLOWANCE_BYTES = 1_048_576;

test('the Socket.IO buffer fits the largest attachment encoded as base64 plus its envelope', () => {
  const base64AttachmentBytes = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;
  assert.ok(
    SOCKET_MAX_HTTP_BUFFER_BYTES >=
      base64AttachmentBytes + ENVELOPE_ALLOWANCE_BYTES,
    `${SOCKET_MAX_HTTP_BUFFER_BYTES} < ${base64AttachmentBytes} + ${ENVELOPE_ALLOWANCE_BYTES}`,
  );
});

test('the Socket.IO buffer is 8_039_084 bytes (AC2.4)', () => {
  assert.equal(SOCKET_MAX_HTTP_BUFFER_BYTES, 8_039_084);
});
