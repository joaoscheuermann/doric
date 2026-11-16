import { cn } from 'desktop/ui/utils';
import { useEffect, useRef, useState } from 'react';

import { limitName, nameError } from '../../domain/workspace.js';

type EditableNameProps = {
  readonly className?: string;
  readonly creating?: boolean;
  /** A display label for an existing entity with no name. */
  readonly placeholder?: string;
  /** Whether the name is open for typing. */
  readonly editing: boolean;
  readonly label: string;
  readonly onCancel: () => void;
  /** Opens the name for typing, for a caller that shows a closed name. */
  readonly onStart?: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
  /** The stored name, which may be empty for an unnamed Thread. */
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
 * A creation has nothing to restore on cancel and nothing to leave behind on
 * blur; a rename does both, even when the existing entity has no name yet.
 *
 * A refused or failed save marks the name itself — the text wears a red
 * underline. A name the field refuses says why in a line under the name; a
 * request that fails says nothing here, because the workspace notice states it
 * (§8). Typing clears the mark.
 */
export function EditableName({
  className,
  creating = false,
  editing,
  label,
  onCancel,
  onStart,
  onSubmit,
  placeholder,
  value,
}: EditableNameProps) {
  const element = useRef<HTMLSpanElement>(null);
  /** Why the field refused the name, while the mark stands. */
  const [invalid, setInvalid] = useState<string>();
  /** Whether the last save failed; the workspace notice says why. */
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const marked = invalid !== undefined || failed;

  const clearMark = () => {
    setInvalid(undefined);
    setFailed(false);
  };

  useEffect(() => {
    const current = element.current;
    if (current === null) return;
    if (!editing) {
      current.textContent = value || placeholder || '';
      setInvalid(undefined);
      setFailed(false);
      setPending(false);
      return;
    }
    current.textContent = value;
    current.focus();
    selectContents(current);
  }, [editing, placeholder, value]);

  const text = (): string => element.current?.textContent ?? '';

  const refocus = () =>
    requestAnimationFrame(() => {
      element.current?.focus();
      if (element.current) selectContents(element.current);
    });

  const cancel = () => {
    if (element.current)
      element.current.textContent = value || placeholder || '';
    clearMark();
    setPending(false);
    onCancel();
  };

  const submit = async () => {
    if (!editing || pending) return;
    const next = text();
    // An entity being created has nothing to save while the name is empty.
    if (creating && next.trim().length === 0) {
      refocus();
      return;
    }
    const reason = nameError(next);
    if (reason) {
      setInvalid(reason);
      setFailed(false);
      refocus();
      return;
    }
    setPending(true);
    clearMark();
    try {
      await onSubmit(next.trim());
    } catch {
      setFailed(true);
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
    if (creating || next === value.trim()) cancel();
    else void submit();
  };

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the role and the handlers move together — this is a textbox exactly while it is editable */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label is set only alongside the textbox role, which Biome cannot correlate across the two conditionals */}
      <span
        ref={element}
        role={editing ? 'textbox' : undefined}
        aria-label={editing ? label : undefined}
        aria-invalid={editing && marked ? true : undefined}
        contentEditable={editing && !pending}
        data-placeholder="..."
        suppressContentEditableWarning
        spellCheck={false}
        className={cn(
          'min-w-0 flex-1 truncate select-none',
          className,
          editing &&
            'cursor-text select-text text-sidebar-accent-foreground underline decoration-sidebar-ring underline-offset-4 outline-none',
          marked && 'decoration-destructive',
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
          clearMark();
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
        {editing ? value : value || placeholder}
      </span>
      {invalid !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {invalid}
        </p>
      )}
    </>
  );
}
