// `comment-flow.ts` — what is open over the canvas and what its field holds
// (spec: the comment flow, Figma's). A click in comment mode opens the inline
// input of a new comment at its pin; a pin that holds its first comment opens
// its thread, whose field replies (or edits one of its drafts). Only a
// confirmed note reaches the Thread's composer stack — as a draft, nothing
// durable. `Cmd/Ctrl+Enter` is the window's: in the conversation chat's send
// asks first (`doric:prompt-send`) and the open note joins the stack before
// it goes; in the canvas modal the header's send button runs `sendNow`. The
// stack is the owner's (`CommentStore`), for its own comment kind.
//
// The actions are one stable set for the frame's lifetime: each reads the
// latest render (`self`) when it runs, so the header, the footer and the
// bar can be memoised on them, and a pan never re-renders those.

import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';

import type { ContentPoint } from './geometry.js';
import type { CommentPin } from './pins-layer.js';
import type { CanvasThread } from './threads.js';
import {
  artifactTargetOf,
  type CanvasCommentTarget,
  type CanvasDraft,
  nextPinOf,
  type ThreadView,
  threadViewOf,
} from './threads-view.js';

/** What starting a comment became: a stack item, or nothing (no stack to join). */
export type CommentOutcome =
  | { readonly kind: 'stack'; readonly itemId: string }
  | { readonly kind: 'unavailable' };

/**
 * The owner's composer stack for its comment kind, as the comment flow drives
 * it. Every method settles; one that rejects leaves the gesture behind it
 * without effect (the flow swallows it).
 */
export interface CommentStore<D> {
  /** Adds one draft with its note to the Thread's stack. */
  begin(data: D, note: string): Promise<CommentOutcome>;
  /** Edits the note of one draft of the stack. */
  edit(itemId: string, note: string): Promise<void>;
  /** Removes one draft from the stack: it never reaches the log. */
  remove(itemId: string): Promise<void>;
  /** Sends the Thread's stack now. */
  send(): Promise<'accepted' | 'empty' | 'refused' | 'unavailable'>;
  /** Resolves or reopens one sent root, under the prompt it was written in. */
  resolve(input: {
    readonly commentId: string;
    readonly promptId: string | undefined;
    readonly resolved: boolean;
  }): Promise<'done' | 'unavailable'>;
  /** Chat's DOM send event, `doric:prompt-send`; read once, when the flow mounts. */
  readonly promptSendEvent: string;
}

/** The data one stack item of a canvas comment carries. */
export interface CanvasCommentData<A> {
  readonly target: CanvasCommentTarget<A>;
  /** The pin's number. */
  readonly pin?: number;
  /** The root comment (or root draft) this reply answers. */
  readonly inReplyTo?: string;
  /** The artifact the comment was written on: its title and source, for chat's line. */
  readonly refs?: { readonly title?: string; readonly source?: string };
  /** Where the pin sits, in content coordinates, when it was placed. */
  readonly point?: ContentPoint;
}

/* Internal, not exported: the detail of `promptSendEvent`, structurally chat's `PromptSendDetail`. */
interface PromptSendDetail {
  readonly threadId: string;
  waitUntil(pending: Promise<unknown>): void;
}

/**
 * What is open over the canvas, if anything: the inline input of a new
 * comment, or the thread of a pin (keyed by its root's id, which a draft
 * keeps once it is sent; a reply's id opens its root's thread).
 */
export type OpenComment<A> =
  | { readonly kind: 'new'; readonly data: CanvasCommentData<A> }
  | { readonly kind: 'thread'; readonly rootId: string };

export interface CommentFlowInput<A> {
  readonly store: CommentStore<CanvasCommentData<A>>;
  /** The Thread whose stack this is: chat's send for it confirms the open note first. */
  readonly threadId: string | undefined;
  readonly artifactId: string;
  /** The revision on screen: what a new comment is written against. */
  readonly revision: number | undefined;
  readonly threads: readonly CanvasThread<A>[];
  readonly drafts: readonly CanvasDraft<A>[];
  /** The artifact's title and source, for the stack's line to name. */
  readonly refs: { readonly title?: string; readonly source?: string };
  /** Rereads the durable comments (after a resolve). */
  readonly reloadComments: () => void;
  /** Shows the resolved pins: a resolved thread opens with its pin shown. */
  readonly showResolvedPins: () => void;
  /** The frame, brought into view when the conversation asks for a thread. */
  readonly container: RefObject<HTMLElement | null>;
}

/**
 * What is open over the canvas, what its field holds, and the actions on it.
 * The actions are one stable set for the flow's lifetime: each reads the
 * latest input when it runs.
 */
export interface CommentFlow<A> {
  readonly open: OpenComment<A> | undefined;
  /** What the open field holds. */
  readonly text: string;
  /** The draft of the open thread whose note the field edits, if any. */
  readonly editing: string | undefined;
  /** The thread open over the canvas, as its popover shows it. */
  readonly thread: ThreadView<A> | undefined;
  readonly setText: (value: string) => void;
  readonly closeInput: () => void;
  /**
   * Confirms what the open field holds. A new note joins the stack as a
   * draft (only now). In a thread, a reply joins the stack answering the
   * thread's root on the root's own target, and an edit updates its draft —
   * an emptied one is removed. An empty note confirms nothing. `close`
   * (default true) closes the thread too; a new comment's input always closes.
   */
  readonly confirmInput: (close?: boolean) => Promise<void>;
  /** Click outside or focus leaving: a note is kept as a draft, an empty one discarded. */
  readonly resolveInput: () => void;
  /** Sends the stack now, after confirming what the open field holds. */
  readonly sendNow: () => Promise<void>;
  /**
   * Opens the input of a new comment at the anchor a click resolved to, on
   * `artifactTargetOf(artifactId, revision, anchor)` with the next pin; does
   * nothing while `revision` is undefined. The stack is untouched.
   */
  readonly beginNew: (anchor: A, point: ContentPoint) => void;
  /** A pin opens its thread; the field opens empty, to reply. */
  readonly openPin: (pin: CommentPin) => void;
  /** Loads one draft of the open thread into the field, to edit it. */
  readonly editDraft: (itemId: string) => void;
  /** Opens one thread asked for from outside the canvas, and shows the frame. */
  readonly showThread: (commentId: string) => void;
  /** Removes one draft of the stack, and the draft replies that answer it. */
  readonly removeDraft: (itemId: string) => void;
  /** Resolves or reopens the open thread's sent root, under its own prompt, then rereads. */
  readonly toggleResolved: () => void;
}

interface Latest<A> extends CommentFlowInput<A> {
  readonly open: OpenComment<A> | undefined;
  readonly text: string;
  readonly editing: string | undefined;
  readonly thread: ThreadView<A> | undefined;
}

/**
 * The comment flow of one canvas. While a note is open and chat's
 * `store.promptSendEvent` names `threadId`, the flow hands the note's
 * confirmation to the event's `waitUntil`, so the send carries it.
 */
export const useCommentFlow = <A>(
  input: CommentFlowInput<A>,
): CommentFlow<A> => {
  const [open, setOpen] = useState<OpenComment<A> | undefined>(undefined);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | undefined>(undefined);

  // A reply's id names its thread too: the thread opens at its root.
  const openRootId =
    open?.kind === 'thread'
      ? (input.threads.find((candidate) =>
          candidate.replies.some((reply) => reply.commentId === open.rootId),
        )?.root.commentId ?? open.rootId)
      : undefined;

  // A reply answers the root on the root's own target, the revision it was
  // written on, whatever revision is on screen.
  const thread =
    openRootId === undefined
      ? undefined
      : threadViewOf(openRootId, input.threads, input.drafts, {
          artifactId: input.artifactId,
          ...(input.revision === undefined ? {} : { revision: input.revision }),
        });

  const self = useRef<Latest<A>>({ ...input, open, text, editing, thread });
  self.current = { ...input, open, text, editing, thread };

  const actions = useMemo(() => {
    const closeInput = (): void => {
      setOpen(undefined);
      setText('');
      setEditing(undefined);
    };

    const removeDraft = (itemId: string): void => {
      const { drafts, open, editing, store } = self.current;
      const ids = [
        itemId,
        ...drafts
          .filter((draft) => draft.inReplyTo === itemId)
          .map((draft) => draft.id),
      ];

      for (const id of ids) {
        void store.remove(id).catch(() => undefined);
      }

      if (open?.kind === 'thread' && open.rootId === itemId) closeInput();
      if (editing !== undefined && ids.includes(editing)) {
        setEditing(undefined);
        setText('');
      }
    };

    const confirmInput = async (close = true): Promise<void> => {
      const { open, text, editing, drafts, thread, refs, store } = self.current;
      const note = text.trim();

      if (open?.kind !== 'thread' || close) closeInput();
      else {
        setText('');
        setEditing(undefined);
      }

      try {
        if (open?.kind === 'new') {
          if (note !== '') await store.begin(open.data, note);

          return;
        }

        if (open?.kind !== 'thread') return;

        if (editing !== undefined) {
          const original = drafts.find((draft) => draft.id === editing);

          if (note === '') removeDraft(editing);
          else if (original !== undefined && note !== original.note)
            await store.edit(editing, note);

          return;
        }

        if (note === '' || thread === undefined) return;

        await store.begin(
          {
            target: thread.target,
            pin: thread.pin,
            inReplyTo: thread.rootId,
            refs,
          },
          note,
        );
      } catch {
        // The stack is unreachable: the gesture leaves nothing behind.
      }
    };

    const resolveInput = (): void => {
      void confirmInput();
    };

    const sendNow = async (): Promise<void> => {
      await confirmInput();
      try {
        await self.current.store.send();
      } catch {
        // The stack could not be sent: it stays where it is.
      }
    };

    const beginNew = (anchor: A, point: ContentPoint): void => {
      const { artifactId, revision, threads, drafts, refs } = self.current;

      if (revision === undefined) return;

      // The balloon and its input open at the click; the stack is untouched
      // until the note is confirmed. The pin's number is never one the
      // artifact already shows.
      setOpen({
        kind: 'new',
        data: {
          target: artifactTargetOf(artifactId, revision, anchor),
          pin: nextPinOf(threads, drafts),
          point,
          refs,
        },
      });
      setText('');
      setEditing(undefined);
    };

    const openPin = (pin: CommentPin): void => {
      const { open } = self.current;

      if (open?.kind === 'thread' && open.rootId === pin.key) return;

      if (open !== undefined) void confirmInput();
      setOpen({ kind: 'thread', rootId: pin.key });
      setText('');
      setEditing(undefined);
    };

    const editDraft = (itemId: string): void => {
      const draft = self.current.drafts.find(
        (candidate) => candidate.id === itemId,
      );

      if (draft === undefined) return;

      setEditing(itemId);
      setText(draft.note);
    };

    const showThread = (commentId: string): void => {
      const { open, threads, showResolvedPins, container } = self.current;

      if (open !== undefined) void confirmInput();
      setOpen({ kind: 'thread', rootId: commentId });
      setText('');
      setEditing(undefined);
      // A resolved thread opens with its pin shown.
      if (
        threads.some(
          (candidate) =>
            candidate.root.commentId === commentId &&
            candidate.state === 'done',
        )
      )
        showResolvedPins();
      container.current?.scrollIntoView?.({
        block: 'center',
        behavior: 'smooth',
      });
    };

    const toggleResolved = (): void => {
      const { thread, store, reloadComments } = self.current;
      const root = thread?.sent?.root;

      if (root === undefined) return;

      void store
        .resolve({
          commentId: root.commentId,
          promptId: root.promptId,
          resolved: !root.resolved,
        })
        .then(
          () => reloadComments(),
          () => undefined,
        );
    };

    return {
      setText,
      closeInput,
      confirmInput,
      resolveInput,
      sendNow,
      beginNew,
      openPin,
      editDraft,
      showThread,
      removeDraft,
      toggleResolved,
    };
  }, []);

  // Chat's send is about to read the stack of this canvas's Thread: the note
  // open here joins it first, so the send carries it.
  useEffect(() => {
    const eventName = self.current.store.promptSendEvent;
    const onPromptSend = (event: Event): void => {
      const detail = (event as CustomEvent<PromptSendDetail | undefined>)
        .detail;
      const { open: current, threadId } = self.current;

      if (
        current === undefined ||
        detail === undefined ||
        detail.threadId !== threadId
      )
        return;
      detail.waitUntil(actions.confirmInput());
    };

    document.addEventListener(eventName, onPromptSend);

    return () => document.removeEventListener(eventName, onPromptSend);
  }, [actions]);

  return { open, text, editing, thread, ...actions };
};

/**
 * The frame's comment gesture (bumping `request`): each change toggles the
 * comment tool and closes what was open. Arming the tool from outside
 * focuses the canvas first; a request made while `canComment` is false is
 * spent without arming anything. The first `request` seen is not a change.
 */
export const useCommentRequest = (
  request: number | undefined,
  input: {
    readonly canComment: boolean;
    /** Whether the comment tool is armed now. */
    readonly armed: () => boolean;
    /** Arms the tool, or disarms it. */
    readonly toggle: () => void;
    readonly focusCanvas: () => void;
    readonly closeInput: () => void;
  },
): void => {
  const handled = useRef(request);
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    if (request === handled.current) return;

    handled.current = request;

    const { canComment, armed, toggle, focusCanvas, closeInput } =
      latest.current;

    if (!canComment) return;

    if (!armed()) focusCanvas();
    toggle();
    closeInput();
  }, [request]);
};
