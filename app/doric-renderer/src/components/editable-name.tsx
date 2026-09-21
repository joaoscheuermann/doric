import { messageFrom, nameError } from '@/app/workspace';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';

type EditableNameProps = {
  readonly editing: boolean;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onStart: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
  readonly value: string;
};

const selectContents = (element: HTMLElement): void => {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
};

export function EditableName({
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

  const cancel = () => {
    if (element.current) element.current.textContent = value;
    setError(undefined);
    setPending(false);
    onCancel();
  };

  const submit = async () => {
    if (!editing || pending) return;
    const next = element.current?.textContent ?? '';
    const invalid = nameError(next);
    if (invalid) {
      setError(invalid);
      element.current?.focus();
      if (element.current) selectContents(element.current);
      return;
    }

    setPending(true);
    setError(undefined);
    try {
      await onSubmit(next.trim());
    } catch (reason) {
      setError(messageFrom(reason));
      setPending(false);
      requestAnimationFrame(() => {
        element.current?.focus();
        if (element.current) selectContents(element.current);
      });
    }
  };

  return (
    <span
      ref={element}
      role={editing ? 'textbox' : undefined}
      aria-label={editing ? label : undefined}
      aria-invalid={editing ? Boolean(error) : undefined}
      contentEditable={editing && !pending}
      data-placeholder="..."
      suppressContentEditableWarning
      spellCheck={false}
      title={error}
      className={cn(
        'min-w-0 flex-1 truncate select-none',
        editing &&
          'cursor-text select-text text-sidebar-accent-foreground underline decoration-sidebar-ring underline-offset-4 outline-none',
        error && 'decoration-destructive',
        pending && 'opacity-60',
      )}
      onClick={(event) => {
        if (editing) event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!editing) onStart();
      }}
      onBlur={() => void submit()}
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
  );
}
