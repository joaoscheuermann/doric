// `program-errors-card.tsx` — the program's errors in one card under the
// canvas (papercraft-openui.md D26, "Errors"; openui.md D18, "The reader's
// card"), in both chromes.

import { CircleAlertIcon } from 'lucide-react';
import type { ShownError } from 'openui/contracts';

export interface ProgramErrorsCardProps {
  /** The card's lines; at least one. */
  readonly lines: readonly ShownError[];
  /** The node reported them: the footer is drawn only when true. */
  readonly sent: boolean;
}

/** One card: "N errors", each line's statement before its message, no code. */
export function ProgramErrorsCard({ lines, sent }: ProgramErrorsCardProps) {
  return (
    <section
      aria-label="Program errors"
      data-testid="papercraft-program-errors"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5"
    >
      <header className="flex items-center gap-1.5 text-xs text-destructive">
        <CircleAlertIcon className="size-3.5" />
        {lines.length === 1 ? '1 error' : `${String(lines.length)} errors`}
      </header>
      <ul className="flex flex-col gap-1.5">
        {lines.map((line) => (
          <li
            key={`${line.code ?? ''}:${line.statementId ?? ''}:${line.message}`}
            className="text-xs text-muted-foreground"
          >
            {line.statementId === undefined ? null : (
              <span className="font-mono text-foreground">
                {`${line.statementId}: `}
              </span>
            )}
            {line.message}
          </li>
        ))}
      </ul>
      {sent ? (
        <p className="text-xs text-muted-foreground/70">Sent to the agent.</p>
      ) : null}
    </section>
  );
}
