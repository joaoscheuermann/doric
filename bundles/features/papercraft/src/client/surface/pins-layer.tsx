// `pins-layer.tsx` — the numbered comment pins, in light DOM, over the shadow
// root (spec: "Uma superfície, duas molduras").
//
// Each commented click becomes a pin: `[1]` anchored to the element,
// `[2]` at a free position. The pins are light DOM above the shadow root so
// they never mix with the artifact's document, positioned in content
// coordinates and carried through the viewport transform — they sit on what
// they annotate under any pan/zoom. The count is what the node's comment
// button and the toolbar's `Comentar` control carry as a `Badge`.

import { Badge } from 'desktop/ui/badge';
import { cn } from 'desktop/ui/utils';

import type { Viewport } from './viewport.js';

/** One pin: its number and where it sits, in content coordinates. */
export interface CommentPin {
  readonly pin: number;
  readonly point: { readonly x: number; readonly y: number };
  readonly note: string;
}

/** The `[N]` mark of one pending comment, drawn at its content point. */
export function Pin({
  pin,
  point,
  viewport,
  selected,
  onSelect,
}: {
  readonly pin: number;
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: Viewport;
  readonly selected?: boolean;
  readonly onSelect?: (pin: number) => void;
}) {
  return (
    <button
      type="button"
      data-testid="papercraft-pin"
      className={cn(
        'absolute z-10 -translate-x-1/2 -translate-y-full rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] leading-tight font-medium text-foreground shadow-sm',
        selected && 'ring-2 ring-ring',
      )}
      style={{
        left: `${String(point.x * viewport.scale + viewport.tx)}px`,
        top: `${String(point.y * viewport.scale + viewport.ty)}px`,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(pin);
      }}
    >
      [{String(pin)}]
    </button>
  );
}

/** Every pin of the revision, over the canvas. */
export function PinsLayer({
  pins,
  viewport,
  selectedPin,
  onSelect,
}: {
  readonly pins: readonly CommentPin[];
  readonly viewport: Viewport;
  readonly selectedPin?: number;
  readonly onSelect?: (pin: number) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {pins.map((pin) => (
        <div key={pin.pin} className="pointer-events-auto contents">
          <Pin
            pin={pin.pin}
            point={pin.point}
            viewport={viewport}
            selected={selectedPin === pin.pin}
            onSelect={onSelect}
          />
        </div>
      ))}
    </div>
  );
}

/** The pin count the comment controls carry. */
export function PinCount({ count }: { readonly count: number }) {
  return (
    <span className="papercraft-pin-count" data-count={String(count)}>
      {count === 0 ? null : <Badge variant="secondary">{String(count)}</Badge>}
    </span>
  );
}
