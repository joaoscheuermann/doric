// The reader's error card (openui.md D18, U49; conversation-openui.md D29,
// "The reader's error card"): a fence's errors in one card under it.

import { CircleAlertIcon } from 'lucide-react';
import { createElement, type ReactNode } from 'react';

import type { ShownError } from '../../contracts/index.js';

export interface ErrorsCardProps {
  /** The card's lines, from `shownErrors`; at least one. */
  readonly lines: readonly ShownError[];
  /** The reporter's `sent()`: the footer is drawn only when true. */
  readonly sent: boolean;
}

/** One card: "N errors", each line's statement before its message, no code. */
export function ErrorsCard({ lines, sent }: ErrorsCardProps): ReactNode {
  return createElement(
    'section',
    {
      'aria-label': 'Program errors',
      'data-testid': 'openui-fence-errors',
      className:
        'flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5',
    },
    createElement(
      'header',
      { className: 'flex items-center gap-1.5 text-xs text-destructive' },
      createElement(CircleAlertIcon, { className: 'size-3.5' }),
      lines.length === 1 ? '1 error' : `${String(lines.length)} errors`,
    ),
    createElement(
      'ul',
      { className: 'flex flex-col gap-1.5' },
      ...lines.map((line) =>
        createElement(
          'li',
          {
            key: `${line.code ?? ''}:${line.statementId ?? ''}:${line.message}`,
            className: 'text-xs text-muted-foreground',
          },
          line.statementId === undefined
            ? null
            : createElement(
                'span',
                { className: 'font-mono text-foreground' },
                `${line.statementId}: `,
              ),
          line.message,
        ),
      ),
    ),
    sent
      ? createElement(
          'p',
          { className: 'text-xs text-muted-foreground/70' },
          'Sent to the agent.',
        )
      : null,
  );
}
