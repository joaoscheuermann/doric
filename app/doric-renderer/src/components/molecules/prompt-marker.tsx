/**
 * One prompt lifecycle event as the conversation shows it: a quiet row inside the
 * transcript — its icon, and the line the event reads as — with the button that
 * takes a paused prompt up again when the pause still offers it.
 *
 * The wording, the icon and whether the action belongs on the row are the rules
 * in `@/domain/prompt-lifecycle`; this only puts them beside each other, so a
 * row reads the same wherever it is drawn.
 */
import { Button } from '@/components/ui/button';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import {
  type LifecycleEvent,
  type LifecycleIcon,
  lifecycleMarker,
} from '@/domain/prompt-lifecycle';
import { type LucideIcon, PauseIcon, PlayIcon } from 'lucide-react';

/** The mark each lifecycle row wears. */
const MARKS: Record<LifecycleIcon, LucideIcon> = {
  pause: PauseIcon,
  play: PlayIcon,
};

export function PromptMarker({
  event,
  onResume,
}: {
  readonly event: LifecycleEvent;
  /** Takes the paused prompt up again; the row draws the action only when it offers it. */
  readonly onResume?: () => void;
}) {
  const marker = lifecycleMarker(event);
  const Mark = MARKS[marker.icon];

  return (
    <Marker variant="default">
      <MarkerIcon>
        <Mark />
      </MarkerIcon>
      <MarkerContent>{marker.label}</MarkerContent>
      {marker.action && onResume !== undefined ? (
        <Button onClick={onResume} size="xs" type="button" variant="ghost">
          Retomar
        </Button>
      ) : null}
    </Marker>
  );
}
