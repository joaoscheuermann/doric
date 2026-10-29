// The measure frame protocol's values a frame needs at run time, apart from
// `frame-protocol.ts`: that module builds the zod schemas the app validates
// frame messages with, and a frame that imported a value from it would carry
// zod (and the contracts) along. The frame imports its types from
// `frame-protocol.ts` (`import type`, erased) and its values from here.

/** The protocol's version; both ends refuse another. */
export const DIAGRAM_FRAME_PROTOCOL = 1;

/** The longest `error` message a frame sends, in characters (as Papercraft's). */
export const FRAME_ERROR_LIMIT = 4096;
