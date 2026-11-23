// `comments`' host part (phase 3, S52a): `comments/v1` and the
// `comment_reply` tool served over the routed ports.

import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import {
  createToolHandlers,
  type HostContext,
  type ToolHandlers,
} from 'bundle/host';

import type { CommentsService } from '../contracts/gen/doric/comments/v1/comments_pb.js';
import {
  addInputOf,
  commentMessageOf,
  listInputOf,
  resolveInputOf,
} from './codec.js';
import { addComment, listComments, resolveComment } from './comments.js';
import type { CommentsPorts } from './ports.js';
import { registerCommentEvents, routedCommentsPorts } from './routed.js';
import { COMMENT_REPLY_ORDER, tool } from './tools/comment-reply.js';

export interface CommentsHost {
  /**
   * `comments/v1` over the router. Each method converts its request with
   * `./codec.ts`, runs the registry over the routed ports with
   * `callOf(context)` and converts the answer:
   * - `Add` → `{comment}`;
   * - `List` → `{comments}`, in `listComments` order;
   * - `Resolve` → `{comment?}`, absent when the call's Thread holds no such comment.
   * Errors: `invalid_scope`, `invalid_input` as the registry's; `invalid_input`
   * from protovalidate before the handler; the routed providers' codes
   * unchanged; `invalid_output` from `commentMessageOf`; `unavailable` before
   * `activate`; `limit_exceeded` for an answer over 4 MiB (RK36).
   */
  readonly comments: ServiceImpl<typeof CommentsService>;
  /** The tool table `main.ts` serves as `ToolHandlerService`. */
  readonly tools: ToolHandlers;
  /**
   * Binds the routed ports, then `registerCommentEvents(context)`, then
   * `tools.register(context, tool.bind(ports), {alwaysAvailable: true, order:
   * COMMENT_REPLY_ORDER})`. Rejects with the first refusal; the service stays
   * `unavailable` and the tool unserved after a refusal.
   */
  activate(
    context: Pick<HostContext, 'services' | 'registrations'>,
  ): Promise<void>;
}

/** Builds the host part with no I/O; never throws. */
export const createCommentsHost = (): CommentsHost => {
  const tools = createToolHandlers();
  let active: CommentsPorts | undefined;

  const ports = (): CommentsPorts => {
    if (active === undefined) {
      throw new ContractError('unavailable', 'comments is not activated.');
    }

    return active;
  };

  return {
    comments: {
      add: async (request, context) => ({
        comment: commentMessageOf(
          await addComment(ports(), callOf(context), addInputOf(request)),
        ),
      }),
      list: async (request, context) => ({
        comments: (
          await listComments(ports(), callOf(context), listInputOf(request))
        ).map(commentMessageOf),
      }),
      resolve: async (request, context) => {
        const comment = await resolveComment(
          ports(),
          callOf(context),
          resolveInputOf(request),
        );

        return comment === undefined
          ? {}
          : { comment: commentMessageOf(comment) };
      },
    },
    tools,
    activate: async (context) => {
      const routed = routedCommentsPorts(context.services);

      await registerCommentEvents(context);
      await tools.register(context, tool.bind(routed), {
        alwaysAvailable: true,
        order: COMMENT_REPLY_ORDER,
      });
      active = routed;
    },
  };
};
