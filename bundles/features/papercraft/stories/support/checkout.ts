// What the story host answers for the `Checkout` preview: the registry's
// records of its revisions, the built markup `papercraft.previews/v1` reads,
// the comment threads written on it (one open, one awaiting the reader, one
// resolved) and the drafts still in the Thread's composer stack. Every anchor
// names a stamped element of the markup, so the canvas places each pin on
// the element it was written on.

import type { ComposerItem } from '../../src/contracts/chat.js';
import {
  ARTIFACT_TARGET_KIND,
  type ArtifactRecord,
  type Comment,
  type CommentAnchor,
  type CommentTarget,
  PAPERCRAFT_COMMENT_KIND,
  type PreviewItemData,
  type PreviewState,
  type ThreadLogEvent,
} from '../../src/contracts/index.js';
import {
  ARTIFACT_ID,
  checkoutMarkup,
  minutesAgo,
  SOURCE,
  TITLE,
} from './preview.js';

/** The registry's record of one revision of the preview. */
export const checkoutRecord = (
  revision: number,
  revisions: number,
  approved = false,
): ArtifactRecord => ({
  artifactId: ARTIFACT_ID,
  kind: 'preview',
  title: TITLE,
  revision,
  revisions,
  targets: [{ path: SOURCE, line: 10 }],
  source: 'component',
  path: SOURCE,
  entry: 'Checkout',
  state: approved ? 'approved' : 'open',
  createdAt: minutesAgo(40 - revision * 10),
  createdBy: 'agent',
});

/** What `papercraft.previews/v1.read` answers for one revision. */
export const checkoutPreview = (
  revision: number,
  entries: readonly string[] = ['index.html'],
): PreviewState => ({
  artifactId: ARTIFACT_ID,
  revision,
  kind: 'preview',
  files: entries.map((path) => ({
    path,
    sha256: `9f2c4e7a1b3d${String(revision)}${path.length.toString(16)}`,
  })),
  markup: checkoutMarkup(revision),
});

/** An anchor on one stamped element of the checkout, at an offset inside it. */
export const stampAnchor = (
  line: number,
  label: string,
  offset: { readonly x: number; readonly y: number } = { x: 0.92, y: 0.2 },
): CommentAnchor =>
  ({
    form: 'source',
    path: SOURCE,
    line,
    label,
    offset,
  }) as CommentAnchor;

export const checkoutTarget = (
  anchor: CommentAnchor,
  revision = 1,
): CommentTarget => ({
  kind: ARTIFACT_TARGET_KIND,
  id: ARTIFACT_ID,
  revision,
  anchor,
});

/* The durable threads, as the Thread's log and `comments/v1` hold them ----- */

interface SeedComment {
  readonly commentId: string;
  readonly text: string;
  readonly author?: string;
  readonly inReplyTo?: string;
  readonly anchor: CommentAnchor;
  readonly minutes: number;
  readonly promptId: string;
}

const SEED: readonly SeedComment[] = [
  {
    commentId: 'comment-pay-label',
    text: 'The pay button should say the total, not just "Pay now".',
    anchor: stampAnchor(21, 'button'),
    minutes: 32,
    promptId: 'prompt-1',
  },
  {
    commentId: 'comment-pay-label-reply',
    text: 'Agreed, and keep it on one line at 360px.',
    inReplyTo: 'comment-pay-label',
    anchor: stampAnchor(21, 'button'),
    minutes: 30,
    promptId: 'prompt-1',
  },
  {
    commentId: 'comment-seats',
    text: 'Should extra seats be monthly here, or annual like the plan?',
    anchor: stampAnchor(17, 'li', { x: 0.6, y: 0.1 }),
    minutes: 25,
    promptId: 'prompt-2',
  },
  {
    commentId: 'comment-seats-agent',
    text: 'They bill with the plan, so annual. Do you want the per-month price shown next to it?',
    author: 'agent',
    inReplyTo: 'comment-seats',
    anchor: stampAnchor(17, 'li', { x: 0.6, y: 0.1 }),
    minutes: 22,
    promptId: 'prompt-2',
  },
  {
    commentId: 'comment-heading',
    text: 'Heading is too loud next to the lead text.',
    anchor: stampAnchor(12, 'h1', { x: 0.3, y: 0.1 }),
    minutes: 50,
    promptId: 'prompt-1',
  },
];

/** The comments resolved on the log. */
const RESOLVED = new Set(['comment-heading']);

/** What `comments/v1.list` answers for the preview. */
export const checkoutComments = (): Comment[] =>
  SEED.map((seed) => ({
    commentId: seed.commentId,
    target: checkoutTarget(seed.anchor),
    text: seed.text,
    ...(seed.author === undefined ? {} : { author: seed.author }),
    resolved: RESOLVED.has(seed.commentId),
    createdAt: minutesAgo(seed.minutes),
    ...(seed.inReplyTo === undefined ? {} : { inReplyTo: seed.inReplyTo }),
    promptId: seed.promptId,
  }));

/** The `comments.*` events of the Thread's log, in order. */
export const checkoutLog = (): ThreadLogEvent[] => {
  const added = [...SEED]
    .sort((a, b) => b.minutes - a.minutes)
    .map(
      (seed): ThreadLogEvent => ({
        promptId: seed.promptId,
        type: 'comments.added/v1',
        createdAt: minutesAgo(seed.minutes),
        event: {
          commentId: seed.commentId,
          target: checkoutTarget(seed.anchor),
          text: seed.text,
          ...(seed.author === undefined ? {} : { author: seed.author }),
          ...(seed.inReplyTo === undefined
            ? {}
            : { inReplyTo: seed.inReplyTo }),
          createdAt: minutesAgo(seed.minutes),
        },
      }),
    );

  const resolved = [...RESOLVED].map(
    (commentId): ThreadLogEvent => ({
      promptId: 'prompt-1',
      type: 'comments.resolved/v1',
      createdAt: minutesAgo(20),
      event: { commentId, resolved: true },
    }),
  );

  return [...added, ...resolved];
};

/* The drafts in the Thread's composer stack ---------------------------------- */

const draftItem = (
  id: string,
  note: string,
  data: PreviewItemData,
): ComposerItem => ({
  id,
  kind: PAPERCRAFT_COMMENT_KIND,
  elementTag: 'chat-comment-line',
  data,
  note,
});

/** A draft root on the total row and a draft reply to the open thread. */
export const checkoutDrafts = (): ComposerItem[] => [
  draftItem('draft-total', 'Bold the total amount, not the label.', {
    target: checkoutTarget(stampAnchor(18, 'li', { x: 0.85, y: 0.3 }), 2),
    pin: 4,
    refs: { title: TITLE, source: SOURCE },
  }),
  draftItem('draft-pay-reply', 'Use the currency format of the locale too.', {
    target: checkoutTarget(stampAnchor(21, 'button'), 2),
    inReplyTo: 'comment-pay-label',
    refs: { title: TITLE, source: SOURCE },
  }),
];
