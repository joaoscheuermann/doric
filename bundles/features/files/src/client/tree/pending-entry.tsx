// The inline name row of New file and New folder (§4.4 A9, A10): drawn by
// `FileTree.pending` as the folder's first child. Enter sends the trimmed
// name (an empty one cancels); Escape cancels; a blur cancels unless the call
// is running, while which the input is read-only. A non-success answer shows
// its text under the input ("Non-success answers in the UI") and keeps the
// row open with the typed name.

import { Input } from 'desktop/ui/input';
import { FileIcon, FolderIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { CreateOutcome, LeaseOutcome } from '../../contracts/index.js';

/** What New file or New folder makes. */
export type EntryKind = 'file' | 'directory';

const invalidName =
  'A name cannot contain / or \\, cannot be . or .., and has at most 255 bytes.';

const leaseTexts = {
  pending: 'The Project is starting. Try again in a moment.',
  unavailable: 'The Project is unavailable.',
  expired: "The Project's sandbox expired. Reopen the Project.",
  missing: 'The Project no longer exists.',
} as const;

/** The text a create answer shows under the name row; none for `created`. */
export const createAnswerText = (
  name: string,
  outcome: LeaseOutcome<CreateOutcome>,
): string | undefined => {
  if (outcome.status !== 'ready') return leaseTexts[outcome.status];
  const answer = outcome.value;
  if (answer.status === 'created') return undefined;
  if (answer.status === 'failed') return answer.message;
  switch (answer.reason) {
    case 'exists':
      return `${name} already exists.`;
    case 'invalid-name':
      return invalidName;
    case 'outside':
      return 'This folder is outside the Project.';
    case 'no-directory':
      return 'This folder no longer exists.';
  }
};

export function PendingEntry({
  kind,
  create,
  onCreated,
  onCancel,
}: {
  readonly kind: EntryKind;
  /** Creates the trimmed name in the folder. */
  readonly create: (name: string) => Promise<LeaseOutcome<CreateOutcome>>;
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string>();
  const label = kind === 'file' ? 'New file name' : 'New folder name';
  const Icon = kind === 'file' ? FileIcon : FolderIcon;

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    const name = value.trim();
    if (name === '') {
      onCancel();
      return;
    }
    setRunning(true);
    let text: string | undefined;
    try {
      text = createAnswerText(name, await create(name));
    } catch {
      text = `Could not create ${name}.`;
    }
    setRunning(false);
    if (text === undefined) onCreated();
    else setMessage(text);
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-1 py-0.5 pr-1.5">
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5!"
        >
          <Icon />
        </span>
        <Input
          ref={input}
          aria-label={label}
          aria-invalid={message === undefined ? undefined : true}
          className="h-6 rounded-[4px] px-1.5 md:text-sm"
          readOnly={running}
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setMessage(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!running) void submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              if (!running) onCancel();
            }
          }}
          onBlur={() => {
            if (!running) onCancel();
          }}
        />
      </div>
      {message !== undefined && (
        <p role="alert" className="pl-5.5 text-xs text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
