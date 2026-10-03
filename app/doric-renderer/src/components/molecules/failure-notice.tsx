/**
 * A prompt the host closed as a failure, as the conversation shows it: the
 * failure's own words beside its mark, in the line's tone.
 *
 * Most failures read as a quiet row — the prompt settled and the run said why.
 * The one that is not quiet is the resume that ran out of attempts: the work may
 * be incomplete and only the reader can decide what happens next, so it reads as
 * a warning in the theme's own warning tone.
 */
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { type PromptFailure, resumeExhausted } from '@/domain/prompt-lifecycle';
import { cn } from '@/utility/utils';
import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';

export function FailureNotice({
  failure,
}: {
  readonly failure: PromptFailure;
}) {
  const warning = resumeExhausted(failure.code);
  const Mark = warning ? TriangleAlertIcon : CircleAlertIcon;

  return (
    <Marker
      className={cn(warning && 'text-warning')}
      role="alert"
      variant="default"
    >
      <MarkerIcon>
        {/* Filled, so a warning reads as a mark rather than an outline. */}
        <Mark
          className={cn(
            warning &&
              'fill-current [&>path:not(:first-child)]:stroke-background',
          )}
        />
      </MarkerIcon>
      <MarkerContent>{failure.message || failure.code}</MarkerContent>
    </Marker>
  );
}
