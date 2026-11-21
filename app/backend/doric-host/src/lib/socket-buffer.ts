/**
 * The largest Socket.IO message the host accepts, in bytes.
 *
 * A desktop call carries an image attachment whole, base64 in its envelope.
 * The number is the base64 size of the largest attachment the runtime keeps,
 * 6,990,508 bytes (4 characters per 3 bytes), plus a 1 MiB allowance for the
 * envelope around it. The kernel keeps it as its own constant so it imports
 * no bundle; the test checks it against the runtime's attachment limit.
 */
export const SOCKET_MAX_HTTP_BUFFER_BYTES = 8_039_084;
