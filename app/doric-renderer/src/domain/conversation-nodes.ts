/**
 * The blocks the conversation renders, and what each one allows.
 *
 * A conversation node names itself with one of these types, and the editor's
 * block plugins — `components/organisms/conversation/plugins` — read the two
 * rules below: a deletion may empty a block but never remove one, and a
 * read-only block's text never changes under an editing command. The rules are
 * stated in terms of type names so they can be checked without a DOM.
 */

/** The block a turn of each kind renders as. */
export const AGENT_TURN_BLOCK = 'agent-turn-node';
export const THINKING_TURN_BLOCK = 'thinking-turn-node';
export const TOOL_TURN_BLOCK = 'tool-turn-node';
export const USER_TURN_BLOCK = 'user-turn-node';

/** The block the reader writes the next prompt in. */
export const USER_PROMPT_BLOCK = 'user-prompt-node';

const UNDELETABLE = new Set([
  AGENT_TURN_BLOCK,
  THINKING_TURN_BLOCK,
  TOOL_TURN_BLOCK,
  USER_TURN_BLOCK,
  USER_PROMPT_BLOCK,
]);

/**
 * Only the agent's turn needs this rule: the thinking and tool turns render as
 * decorators, which the editor already refuses to let anyone type into.
 */
const READ_ONLY = new Set([AGENT_TURN_BLOCK]);

/** Whether a block of this type survives every deletion, empty or not. */
export const isUndeletableBlock = (nodeType: string): boolean =>
  UNDELETABLE.has(nodeType);

/** Whether a block of this type refuses every text-editing command. */
export const isReadOnlyBlock = (nodeType: string): boolean =>
  READ_ONLY.has(nodeType);
