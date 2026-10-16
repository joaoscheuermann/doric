// The `papercraft` client elements (spec: "Composição e partes").
//
// Three public Web Components, all React-backed over the shared
// `desktop/ui/react-element` boundary, as the `threads` bundle publishes its
// delegated turn:
//
//   - `<papercraft-preview>` — one preview revision inside the conversation.
//     Chat hands it the block (`block`), it mounts the frame with
//     `chrome: 'node'`.
//   - `<papercraft-canvas>` — the `/papercraft/:artifactId` route: the same
//     surface full-screen, with `chrome: 'canvas'` (tree left, command bar
//     bottom-centre, `Autorizar` only under the `request` policy).
//   - `<papercraft-comment-card>` — one line of the composer stack, the
//     elementTag the papercraft items of `chat.composer/v1` name.
//
// The classes are made inside factories the activation calls, so importing
// this module touches no DOM global; every element extends `HTMLElement`.

import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';

import {
  PAPERCRAFT_CANVAS_TAG,
  PAPERCRAFT_COMMENT_CARD_TAG,
  PAPERCRAFT_PREVIEW_TAG,
} from '../contracts/index.js';
import type { ComposerItem } from './chat-contract.js';
import { previewBlockDataOf } from './projector.js';
import { CommentCard, type CommentCardData } from './surface/comment-card.js';
import { PreviewContainer } from './surface/preview-container.js';

interface PreviewElementProps {
  readonly block?: unknown;
}

/** `<papercraft-preview>`: one revision inside the conversation. */
export const definePreviewElement = () => {
  const Base = defineReactElement<PreviewElementProps>({
    props: ['block'],
    render: ({ block, services }) => {
      const data = previewBlockDataOf(block);

      if (data === undefined) return null;

      return (
        <PreviewContainer
          services={services}
          chrome="node"
          artifactId={data.artifactId}
          blockRevision={data.revision}
          {...(data.title === undefined ? {} : { blockTitle: data.title })}
        />
      );
    },
  });

  return class PapercraftPreviewElement
    extends Base
    implements PreviewElementProps
  {
    declare block: unknown;
  };
};

interface CanvasElementProps {
  readonly artifactId?: string;
}

/** `<papercraft-canvas>`: the full-screen route of one preview. */
export const defineCanvasElement = () => {
  const Base = defineReactElement<CanvasElementProps>({
    props: ['artifactId'],
    render: ({ artifactId, services }) => {
      if (artifactId === undefined || artifactId === '') return null;

      return (
        <PreviewContainer
          services={services}
          chrome="canvas"
          artifactId={artifactId}
        />
      );
    },
  });

  return class PapercraftCanvasElement
    extends Base
    implements CanvasElementProps
  {
    declare artifactId: string | undefined;
  };
};

interface CommentCardElementProps {
  /** The composer stack item, as chat hands the element its own line. */
  readonly item?: ComposerItem;
  /** The line's number in the stack, as chat numbers it. */
  readonly pin?: number;
  /** Whether the surface opened this line for the reader to write in. */
  readonly open?: boolean;
  /** Edits the draft's note. */
  readonly onNote?: (note: string) => void;
  /** Removes the draft from the stack. */
  readonly onRemove?: () => void;
  /** Reports the line closing. */
  readonly onClose?: () => void;
}

/** `<papercraft-comment-card>`: one line of the composer stack above the prompt. */
export const defineCommentCardElement = () => {
  const Base = defineReactElement<CommentCardElementProps>({
    props: ['item', 'pin', 'open', 'onNote', 'onRemove', 'onClose'],
    render: ({ item, pin, open, onNote, onRemove, onClose }) => {
      if (item === undefined) return null;

      return (
        <CommentCard
          data={item.data as CommentCardData}
          note={item.note}
          pin={pin}
          open={open}
          onNote={onNote}
          onRemove={onRemove}
          onClose={onClose}
          {...(item.author === undefined ? {} : { author: item.author })}
        />
      );
    },
  });

  return class PapercraftCommentCardElement
    extends Base
    implements CommentCardElementProps
  {
    declare item: ComposerItem | undefined;
    declare pin: number | undefined;
    declare open: boolean | undefined;
    declare onNote: ((note: string) => void) | undefined;
    declare onRemove: (() => void) | undefined;
    declare onClose: (() => void) | undefined;
  };
};

/** The tags this module's factories define, as the activation registers them. */
export const PAPERCRAFT_TAGS = [
  [PAPERCRAFT_PREVIEW_TAG, definePreviewElement],
  [PAPERCRAFT_CANVAS_TAG, defineCanvasElement],
  [PAPERCRAFT_COMMENT_CARD_TAG, defineCommentCardElement],
] as const;

export type { Services };
