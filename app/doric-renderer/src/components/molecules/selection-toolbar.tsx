import { Button } from '@/components/ui/button';
import { MessageSquarePlusIcon } from 'lucide-react';

/**
 * The control the surface floats over a span selected inside an answer: one
 * button that starts a comment on it.
 *
 * It is deliberately dumb. The position comes from the surface — the only place
 * that knows what is selected and where it is — and the button always renders, so
 * the surface decides when to mount it. No selection is read here.
 *
 * It wears the class that fixes it to the window (`styles.css`), rather than
 * being positioned against whatever ancestor happens to be positioned: the surface
 * measured the selection against the window, so that is what the button must be
 * placed against, in this app and in any layout this component is dropped into.
 */
export function SelectionToolbar({
  top,
  left,
  onComment,
}: {
  readonly top: number;
  readonly left: number;
  readonly onComment: () => void;
}) {
  return (
    <div className="doric-selection-toolbar" style={{ top, left }}>
      <Button type="button" size="sm" variant="secondary" onClick={onComment}>
        <MessageSquarePlusIcon />
        Comment
      </Button>
    </div>
  );
}
