// `comment-card.tsx` — the line of one comment (spec: "Comentários acima do
// prompt, rascunho no host").
//
// One line per comment, the same element in the composer stack above the
// prompt and in the reader's turn: the avatar — the jdenticon of the author's
// name, the same mark chat's `ReaderAvatar` draws — the author, the note
// truncated with an ellipsis, and the anchor at the end: the file and line
// (or the position, for a comment on empty space) with the pin's number.
//
// It is drawn as a plain React component here and published as
// `<papercraft-comment-card>`, the elementTag the composer stack item names;
// chat resolves the tag as it resolves a conversation block and hands the line
// its own callbacks (`item`, `pin`, `open`, `onNote`, `onRemove`, `onClose`,
// per `composer-stack.tsx`). A line the surface opened becomes editable — the
// draft's note is written there, above the prompt, until the send flushes it.

import { cn } from 'desktop/ui/utils';
import { toSvg } from 'jdenticon';
import { useEffect, useState } from 'react';

import { anchorLabelOf } from '../anchor.js';

/** The identicon the reader carries: the same name always draws the same mark. */
export const identiconSvg = (name: string): string => toSvg(name, 24);

/** The data one composer stack item of the papercraft kind carries. */
export interface CommentCardData {
  readonly artifactId: string;
  readonly revision: number;
  readonly anchor: {
    readonly form: 'source' | 'selector' | 'point' | 'range';
    readonly path?: string;
    readonly line?: number;
    readonly selector?: string;
    readonly x?: number;
    readonly y?: number;
    readonly label?: string;
    readonly text?: string;
  };
  readonly pin: number;
}

/** The frame the reader's identicon is drawn in, as chat draws it. */
function Avatar({ name }: { readonly name: string }) {
  const src = `data:image/svg+xml,${encodeURIComponent(identiconSvg(name))}`;

  return (
    <span
      aria-hidden="true"
      className="flex size-4.5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 [&>svg]:size-full"
    >
      <img src={src} alt="" className="size-full" />
    </span>
  );
}

/** The anchor and pin a line ends with, as chat draws them. */
function Anchor({
  pin,
  anchor,
}: {
  readonly pin: number;
  readonly anchor: CommentCardData['anchor'];
}) {
  return (
    <span className="ml-auto shrink-0 font-mono text-muted-foreground">
      [{String(pin)}] {anchorLabelOf(anchor)}
    </span>
  );
}

/**
 * One comment's line: avatar, author, note, anchor. The stack opens the line it
 * focuses and edits the draft's note in place (`open`, `onNote`); a durable
 * turn draws the same line without those callbacks, so it only reads.
 */
export function CommentCard({
  data,
  note,
  author,
  className,
  pin,
  open,
  onNote,
  onRemove,
  onClose,
}: {
  readonly data: CommentCardData;
  readonly note: string;
  readonly author?: string;
  readonly className?: string;
  /** The line's number from the stack; the item's own pin is the fallback. */
  readonly pin?: number;
  /** Whether the surface opened this line — a draft opens for its note. */
  readonly open?: boolean;
  /** Edits the draft's note, whole words only. */
  readonly onNote?: (note: string) => void;
  /** Removes the draft from the stack. */
  readonly onRemove?: () => void;
  /** Reports the line closing, so the focused one can stop opening. */
  readonly onClose?: () => void;
}) {
  const who = author === undefined || author === '' ? 'você' : author;
  const number = pin ?? data.pin;
  const [draft, setDraft] = useState(note);

  useEffect(() => {
    setDraft(note);
  }, [note]);

  if (open === true && onNote !== undefined) {
    return (
      <span
        className={cn(
          'flex min-w-0 flex-col gap-1.5 text-xs text-foreground',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={who} />
          <span className="shrink-0 truncate">{who}</span>
          <Anchor pin={number} anchor={data.anchor} />
        </span>
        <textarea
          value={draft}
          rows={2}
          aria-label="Note"
          placeholder="What should be different?"
          className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs font-light outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => {
            setDraft(event.target.value);
            onNote(event.target.value);
          }}
        />
        <span className="flex items-center gap-3">
          {onRemove !== undefined && (
            <button
              type="button"
              className="font-light text-muted-foreground hover:text-foreground"
              onClick={() => onRemove()}
            >
              Remove from this send
            </button>
          )}
          {onClose !== undefined && (
            <button
              type="button"
              className="font-light text-muted-foreground hover:text-foreground"
              onClick={() => onClose()}
            >
              Done
            </button>
          )}
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1.5 text-xs text-foreground',
        className,
      )}
    >
      <Avatar name={who} />
      <span className="shrink-0 truncate">{who}</span>
      <span className="min-w-0 truncate">{note === '' ? '…' : `${note}…`}</span>
      <Anchor pin={number} anchor={data.anchor} />
    </span>
  );
}
