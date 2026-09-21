import { limitName, messageFrom, nameError } from '@/app/workspace';
import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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

  const submit = async () => {
    if (settled.current) return;
    const invalid = nameError(value);
    if (invalid) {
      setError(invalid);
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
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  return (
    <Field data-invalid={Boolean(error)}>
      <Input
        ref={input}
        aria-invalid={Boolean(error)}
        aria-label={label}
        className="h-7"
        disabled={pending}
        value={value}
        onBlur={() => void submit()}
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
            settled.current = true;
            onCancel();
          }
        }}
      />
      <FieldError>{error}</FieldError>
    </Field>
  );
}
