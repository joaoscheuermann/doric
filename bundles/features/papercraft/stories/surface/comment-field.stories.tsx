import { useRef, useState } from 'react';

import { Avatar, authorName } from '../../src/client/surface/avatar.js';
import {
  CommentField,
  type CommentFieldProps,
} from '../../src/client/surface/comment-field.js';

/** The field with its own note, as the popover that holds it keeps one. */
function Field({
  initial = '',
  ...props
}: Partial<Omit<CommentFieldProps, 'value' | 'onChange'>> & {
  readonly initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);

  return (
    <div
      className="rounded-lg border border-border bg-popover p-1.5 text-popover-foreground"
      style={{ width: 280 }}
    >
      <CommentField
        fieldRef={field}
        placeholder="Adicionar comentário"
        onConfirm={() => setValue('')}
        onCancel={() => setValue('')}
        onSend={() => setValue('')}
        {...props}
        value={value}
        onChange={setValue}
      />
    </div>
  );
}

export default {
  title: 'Papercraft/Surface/Comment field',
  component: CommentField,
};

export const Empty = {
  render: () => <Field autoFocus />,
};

export const WithNote = {
  render: () => <Field initial="The pay button should say the total." />,
};

export const MultiLine = {
  render: () => (
    <Field
      initial={
        'Two things on this card:\n- the total row should be bold\n- the seat line needs the billing period'
      }
    />
  ),
};

/** Editing a draft of the stack: the button saves, even an emptied note. */
export const EditingDraft = {
  render: () => (
    <Field
      action="save"
      placeholder="Editar comentário…"
      initial="Bold the total amount, not the label."
    />
  ),
};

/** The reply row of a thread: the reader's avatar before the field. */
export const ReplyRow = {
  render: () => (
    <Field
      placeholder="Responder…"
      leading={
        <Avatar name={authorName(undefined)} className="mb-1 size-5.5" />
      }
    />
  ),
};
