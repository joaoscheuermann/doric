// The `comments` bundle's host part: it provides the registry (`comments/v1`)
// registers the two durable events and the `comment_reply` tool. Activation does no data work and holds
// no state — a comment is written when a caller adds one, its durable record is
// the event the append leaves in the Thread log, and every read folds that log
// again, so a fresh activation answers what the previous one wrote.

import { EventsV1, type HostContext, ToolsV1 } from 'bundle/contracts';

import {
  commentsAddedEvent,
  commentsResolvedEvent,
} from '../contracts/index.js';
import { commentsService } from './comments.js';
import { COMMENT_REPLY_ORDER, tool } from './tools/comment-reply.js';

export const activate = ({ services }: HostContext): void => {
  services.provide(commentsService());

  const events = services.use(EventsV1);

  events.register(commentsAddedEvent);
  events.register(commentsResolvedEvent);

  // The global model-visible position, the next free band after
  // `papercraft_preview` (1700).
  services
    .use(ToolsV1)
    .register(tool, { alwaysAvailable: true, order: COMMENT_REPLY_ORDER });
};

export {
  AGENT_AUTHOR,
  COMMENT_REPLY_ORDER,
  COMMENT_REPLY_TOOL,
  type CommentReplyInput,
  type CommentReplyOutput,
  tool as commentReplyTool,
} from './tools/comment-reply.js';
