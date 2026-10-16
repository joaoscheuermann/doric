// The comment threads of the conversation a surface shows, as the projection
// folded them from the whole log. The conversation provides them once, so the
// blocks that draw a comment — a user turn's lines, an agent's reply block —
// read the state it is in now and follow it live as later events arrive,
// without the editor rebuilding their nodes.

import { createContext, useContext } from 'react';

import type { CommentThreads } from '../domain/comment-threads.js';

const noThreads: CommentThreads = new Map();

/** The conversation's comment threads, by root comment id. */
export const CommentThreadsContext = createContext<CommentThreads>(noThreads);

/** The comment threads of the conversation this block stands in. */
export const useCommentThreads = (): CommentThreads =>
  useContext(CommentThreadsContext);
