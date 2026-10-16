// The `comment_reply` tool: the agent's answer to one review comment the user
// left, written into the comment's thread.
//
// The prompt that carries a comment names its id (`comment-<uuid>`); the tool
// looks it up in the caller's Thread, normalizes it to the thread's root and
// appends the answer as `comments.added/v1` with `author: "agent"`, pointing
// at the root (`inReplyTo`) and keeping the root's target. With `resolve` it
// also resolves the root (`comments.resolved/v1`), so the user finds the
// comment closed on the canvas.

import { ContractError } from 'bundle/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { addComment, findComment, resolveComment } from '../comments.js';

/** The tool name the model calls. */
export const COMMENT_REPLY_TOOL = 'comment_reply';

/** The global model-visible position, the next free band after `papercraft_preview`. */
export const COMMENT_REPLY_ORDER = 1800;

/** The author the agent's replies are written under. */
export const AGENT_AUTHOR = 'agent';

const description = [
  "Answer one review comment the user left, in the comment's thread.",
  'Say what you changed, or ask what is unclear.',
  'Set `resolve` to true when the comment is done.',
].join(' ');

export const input = z
  .object({
    /** The id of the comment to answer, as the prompt names it. */
    comment_id: z.string().min(1),
    /** The answer, shown to the user in the comment's thread. */
    text: z.string().min(1),
    /** Also mark the comment as resolved. */
    resolve: z.boolean().optional(),
  })
  .strict();

export type CommentReplyInput = z.output<typeof input>;

export const output = z
  .object({
    /** The id of the reply just written. */
    commentId: z.string(),
    /** The root comment the reply answers. */
    inReplyTo: z.string(),
    /** Whether the root comment is resolved now. */
    resolved: z.boolean(),
  })
  .strict();

export type CommentReplyOutput = z.output<typeof output>;

export const tool = defineTool({
  name: COMMENT_REPLY_TOOL,
  description,
  input,
  output,
  execute: async (payload, call, services) => {
    const asked = await findComment(services, call, payload.comment_id);

    if (asked === undefined) {
      throw new ContractError(
        'invalid_input',
        `The comment "${payload.comment_id}" is unknown in this conversation; use an id the prompt names.`,
      );
    }

    const root =
      asked.inReplyTo === undefined
        ? asked
        : await findComment(services, call, asked.inReplyTo);

    if (root === undefined) {
      throw new ContractError(
        'invalid_input',
        `The thread of comment "${payload.comment_id}" has no root comment.`,
      );
    }

    const reply = await addComment(services, call, {
      target: root.target,
      text: payload.text,
      author: AGENT_AUTHOR,
      inReplyTo: root.commentId,
    });

    const resolved =
      payload.resolve === true
        ? (
            (await resolveComment(services, call, {
              commentId: root.commentId,
              resolved: true,
            })) ?? root
          ).resolved
        : root.resolved;

    return { commentId: reply.commentId, inReplyTo: root.commentId, resolved };
  },
});
