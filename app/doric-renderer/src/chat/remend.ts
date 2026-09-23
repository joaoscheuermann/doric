import remend from 'remend';

/**
 * Completes the syntax a streaming prefix leaves open — an unterminated fence,
 * emphasis or inline code — so a document parsed from partial Markdown keeps its
 * shape until the real closing syntax arrives.
 */
export const remendMarkdown = (value: string): string => remend(value);
