import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { limitName, messageFrom, nameError } from '@/domain/workspace';
import { useEffect, useRef, useState } from 'react';

type InlineNameProps = {
  readonly initialValue?: string;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
};

export function InlineName({
  initialValue = '',
  label,
  onCancel,
  onSubmit,
}: InlineNameProps) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const settled = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const focus = () => requestAnimationFrame(() => input.current?.focus());

  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  const submit = async () => {
    if (settled.current) return;
    if (value.trim().length === 0) {
      setError(undefined);
      focus();
      return;
    }
    const invalid = nameError(value);
    if (invalid) {
      setError(invalid);
      focus();
      return;
    }

    settled.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onSubmit(value.trim());
    } catch (reason) {
      setError(messageFrom(reason));
      setPending(false);
      settled.current = false;
      focus();
    }
  };

  return (
    <Field data-invalid={Boolean(error)} className="min-w-0 flex-1 gap-0">
      <Input
        ref={input}
        aria-invalid={Boolean(error)}
        aria-label={label}
        className="h-7 rounded-none border-0 bg-transparent! px-0 py-0 text-xs! shadow-none focus-visible:border-0 focus-visible:ring-0"
        disabled={pending}
        placeholder="..."
        value={value}
        onBlur={cancel}
        onChange={(event) => {
          setValue(limitName(event.target.value));
          setError(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
      />
      <FieldError className="text-xs">{error}</FieldError>
    </Field>
  );
}
