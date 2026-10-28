// The protocol's values a preview frame needs at run time, apart from
// `frame-protocol.ts`: that module builds the zod schemas the app validates
// frame messages with, and a frame that imported a value from it would carry
// zod along. A frame imports its types from `frame-protocol.ts` (`import
// type`, erased) and its values from here.

/** The protocol's version; both ends refuse another. */
export const PROTOCOL = 1;

/** The most nodes a scene carries, in document order. */
export const SCENE_NODE_LIMIT = 400;

/** The longest text excerpt a node carries. */
export const NODE_TEXT_LIMIT = 120;
