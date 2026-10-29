// `comment-field.tsx` — the field a comment is written in, on the canvas: at a
// new pin, and as the reply row of a thread.
//
// It has no surface of its own — it sits inside one: the thread's popover, or
// the popover of a new comment's input, which share the same surface. The
// field (the platform's `InputGroup` with only its textarea, growing with the
// note) and the send button outside it, on its right and bottom-aligned, both
// 28px tall while the note is one line, with the same border and radius. The
// button is neutral and disabled while the note is empty, primary once there
// is something to send.
//
// The field owns its keys — the canvas's `C`, `Esc` and space never see them:
// `Enter` confirms, `Shift+Enter` breaks the line and `Esc` cancels.
// `Cmd/Ctrl+Enter` is the window's send chord, which confirms the note and
// sends the stack; the field only keeps it from writing a line.

import { ArrowUpIcon, CheckIcon } from 'lucide-react';
import { type FocusEvent, type ReactNode, type Ref, useEffect } from 'react';

import { Button } from '../components/button.js';
import { InputGroup, InputGroupTextarea } from '../components/input-group.js';
import { cn } from '../lib/utils.js';

export interface CommentFieldProps {
  readonly value: string;
  readonly placeholder: string;
  /** What the send button does: add the note, or save the draft being edited. */
  readonly action?: 'send' | 'save';
  readonly onChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
  /** Whether the field takes the focus as it opens. */
  readonly autoFocus?: boolean;
  readonly fieldRef?: Ref<HTMLTextAreaElement>;
  readonly className?: string;
  /** What stands before the field: the reply row's avatar. */
  readonly leading?: ReactNode;
  /** The test id of the send button. */
  readonly confirmTestId?: string;
}

/** One comment field and its send button. */
export function CommentField({
  value,
  placeholder,
  action = 'send',
  onChange,
  onConfirm,
  onCancel,
  onBlur,
  autoFocus = false,
  fieldRef,
  className,
  leading,
  confirmTestId,
}: CommentFieldProps) {
  const empty = value.trim() === '';
  const label = action === 'save' ? 'Salvar' : 'Confirmar comentário';

  useEffect(() => {
    if (!autoFocus || fieldRef === undefined || typeof fieldRef === 'function')
      return;

    fieldRef?.current?.focus({ preventScroll: true });
  }, [autoFocus, fieldRef]);

  return (
    <div className={cn('flex items-end gap-1.5', className)}>
      {leading}
      <InputGroup className="min-h-7 flex-1 rounded-md bg-background">
        <InputGroupTextarea
          ref={fieldRef}
          rows={1}
          value={value}
          aria-label={placeholder}
          placeholder={placeholder}
          className="max-h-36 min-h-0 px-2.5 py-1 text-sm leading-[18px] md:text-sm"
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => {
            event.stopPropagation();

            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();

              return;
            }

            if (event.key !== 'Enter') return;

            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();

              return;
            }

            if (event.shiftKey) return;

            event.preventDefault();
            // Saving an emptied draft is how it is removed; a new note needs words.
            if (!empty || action === 'save') onConfirm();
          }}
        />
      </InputGroup>
      <Button
        type="button"
        size="icon-sm"
        variant={empty ? 'outline' : 'default'}
        aria-label={label}
        title={label}
        data-testid={confirmTestId}
        disabled={empty && action !== 'save'}
        className="rounded-md"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          onConfirm();
        }}
      >
        {action === 'save' ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <ArrowUpIcon aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
