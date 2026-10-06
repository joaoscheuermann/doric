/**
 * One prompt lifecycle event as the conversation shows it: a quiet row inside the
 * transcript — the line the event reads as — with the button that
 * takes a paused prompt up again when the pause still offers it.
 *
 * The wording and whether the action belongs on the row are the rules
 * in `@/domain/prompt-lifecycle`; this only puts them beside each other, so a
 * row reads the same wherever it is drawn.
 */
import { Button } from '@/components/ui/button';
import { Marker, MarkerContent } from '@/components/ui/marker';
import {
  type LifecycleEvent,
  lifecycleMarker,
} from '@/domain/prompt-lifecycle';
import { RotateCcwIcon } from 'lucide-react';

export function PromptMarker({
  event,
  onResume,
}: {
  readonly event: LifecycleEvent;
  /** Takes the paused prompt up again; the row draws the action only when it offers it. */
  readonly onResume?: () => void;
}) {
  const marker = lifecycleMarker(event);

  return (
    <Marker variant="separator" className="gap-1.5 text-xs">
      <MarkerContent
        title={marker.tooltip}
        className="group-data-[variant=separator]/marker:flex-initial"
      >
        {marker.label}
      </MarkerContent>
      {marker.action && onResume !== undefined ? (
        <Button
          onClick={onResume}
          size="icon-xs"
          type="button"
          variant="ghost"
          aria-label="Resume"
          title="Resume"
        >
          <RotateCcwIcon aria-hidden="true" />
        </Button>
      ) : null}
    </Marker>
  );
}
