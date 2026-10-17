import { useState } from 'react';

import { CommentLine } from '../../../src/client/components/molecules/comment-line.js';
import { StackNote } from '../../../src/client/components/molecules/stack-note.js';
import { checkoutTarget } from '../../support/fixtures.js';

/** One stack line holding its note's editor, as the composer's stack draws it. */
function StackLine({
  id,
  initial,
  pin,
  line,
}: {
  readonly id: string;
  readonly initial: string;
  readonly pin: number;
  readonly line: number;
}) {
  const [note, setNote] = useState(initial);
  const item = { note, target: checkoutTarget(line), pin };
  return (
    <CommentLine
      item={item}
      note={
        <StackNote
          id={id}
          note={note}
          label={`Note of comment ${pin}`}
          onText={setNote}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
        />
      }
    />
  );
}

export default {
  title: 'Chat/Molecules/Stack note',
  component: StackNote,
};

export const Note = {
  render: () => (
    <StackLine
      id="comment-draft-1"
      initial="The primary button disappears in dark mode"
      pin={1}
      line={42}
    />
  ),
};

export const Empty = {
  render: () => <StackLine id="comment-draft-2" initial="" pin={2} line={12} />,
};

export const LongNote = {
  render: () => (
    <StackLine
      id="comment-draft-3"
      initial="The total should align with the button baseline, and on small screens the button should take the full width of the card so it is easy to reach"
      pin={3}
      line={44}
    />
  ),
};

export const Stack = {
  render: () => (
    <div className="flex flex-col">
      <StackLine
        id="comment-draft-4"
        initial="The primary button disappears in dark mode"
        pin={1}
        line={42}
      />
      <StackLine id="comment-draft-5" initial="" pin={2} line={18} />
    </div>
  ),
};
