import { limitName, messageFrom, nameError } from '@/domain/workspace';
import { cn } from '@/utility/utils';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';

type EditableNameProps = {
  readonly className?: string;
  /** Whether the name is open for typing. */
  readonly editing: boolean;
  readonly label: string;
  readonly onCancel: () => void;
  /** Opens the name for typing, for a caller that shows a closed name. */
  readonly onStart?: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
  /** The name as it exists. Empty means the entity is being created. */
  readonly value: string;
};

const selectContents = (element: HTMLElement): void => {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
};

/**
 * One name, whether it exists yet or not.
 *
 * Creating and renaming differ only in whether there is a name to show: an empty
 * `value` is an entity being created, a value is one being renamed, and everything
 * else follows from that. A creation has nothing to restore on cancel and nothing
 * to leave behind on blur; a rename does both.
 *
 * A failed edit or save marks the name itself — the text wears a red underline —
 * and says why in a toast, because the reason does not deserve a row of its own in
 * a list this dense. The toast carries the name's id, so repeating the same failure
 * replaces the message instead of stacking it. Typing clears the mark.
 */
export function EditableName({
  className,
  editing,
  label,
  onCancel,
  onStart,
  onSubmit,
  value,
}: EditableNameProps) {
  const element = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const errorId = useId();

  useEffect(() => {
    const current = element.current;
    if (current === null) return;
    if (!editing) {
      current.textContent = value;
      setError(undefined);
      setPending(false);
      return;
    }
    current.focus();
    selectContents(current);
  }, [editing, value]);

  const text = (): string => element.current?.textContent ?? '';

  /** The name keeps the mark; the reason is announced where interruptions are. */
  const report = (message: string) => toast.error(message, { id: errorId });

  const refocus = () =>
    requestAnimationFrame(() => {
      element.current?.focus();
      if (element.current) selectContents(element.current);
    });

  const cancel = () => {
    if (element.current) element.current.textContent = value;
    setError(undefined);
    setPending(false);
    onCancel();
  };

  const submit = async () => {
    if (!editing || pending) return;
    const next = text();
    // An entity being created has nothing to save while the name is empty.
    if (value === '' && next.trim().length === 0) {
      refocus();
      return;
    }
    const invalid = nameError(next);
    if (invalid) {
      setError(invalid);
      report(invalid);
      refocus();
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await onSubmit(next.trim());
    } catch (reason) {
      const message = messageFrom(reason);
      setError(message);
      report(message);
      setPending(false);
      refocus();
    }
  };

  /**
   * Leaving the field settles it: a rename that changed is saved, and anything
   * else is abandoned. Nothing already stored is ever overwritten by a blur.
   */
  const leave = () => {
    if (!editing || pending) return;
    const next = text().trim();
    if (value === '' || next === value.trim()) cancel();
    else void submit();
  };

  return (
    <>
      <span
        ref={element}
        role={editing ? 'textbox' : undefined}
        aria-label={editing ? label : undefined}
        aria-invalid={editing && error !== undefined ? true : undefined}
        contentEditable={editing && !pending}
        data-placeholder="..."
        suppressContentEditableWarning
        spellCheck={false}
        className={cn(
          'min-w-0 flex-1 truncate select-none',
          className,
          editing &&
            'cursor-text select-text text-sidebar-accent-foreground underline decoration-sidebar-ring underline-offset-4 outline-none',
          error !== undefined && 'decoration-destructive',
          pending && 'opacity-60',
        )}
        onBlur={leave}
        onClick={(event) => {
          if (editing) event.stopPropagation();
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!editing) onStart?.();
        }}
        onInput={(event) => {
          const current = event.currentTarget;
          const limited = limitName(current.textContent ?? '');
          if (limited !== current.textContent) current.textContent = limited;
          setError(undefined);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          document.execCommand(
            'insertText',
            false,
            event.clipboardData.getData('text/plain'),
          );
        }}
      >
        {value}
      </span>
    </>
  );
}
