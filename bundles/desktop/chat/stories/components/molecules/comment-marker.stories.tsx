import { CommentLine } from '../../../src/client/components/molecules/comment-line.js';
import {
  CommentStateGlyph,
  markerLabel,
} from '../../../src/client/components/molecules/comment-marker.js';
import type { CommentThreadState } from '../../../src/client/domain/comment-threads.js';

const target = {
  kind: 'artifact',
  id: 'checkout-1',
  revision: 3,
  title: 'Checkout',
  anchor: {
    form: 'element',
    selector: 'button',
    path: 'src/components/Checkout.tsx',
    line: 42,
    label: 'button',
  },
};

const open = (): void => console.info('Doric story: open thread');

export default {
  title: 'Chat/Molecules/Comment marker',
  component: CommentStateGlyph,
};

export const Awaiting = {
  render: () => <CommentStateGlyph state="await" onClick={open} />,
};

export const Resolved = {
  render: () => <CommentStateGlyph state="done" onClick={open} />,
};

export const Open = {
  render: () => <CommentStateGlyph state="open" onClick={open} />,
};

const states: readonly CommentThreadState[] = ['await', 'open', 'done'];

/** Each state at the end of an agent's reply row, with what it reads out. */
export const OnReplyRows = {
  render: () => (
    <div className="flex flex-col">
      {states.map((state, index) => (
        <CommentLine
          key={state}
          item={{
            author: 'agent',
            note: [
              'Should the gap be 8px on mobile too, or only from md up?',
              'I moved the total next to the button; check it on mobile.',
              'Fixed: the button now uses the primary token.',
            ][index] as string,
            target,
            pin: index + 1,
            reply: true,
          }}
          end={
            <>
              <span className="sr-only">
                {markerLabel(state, index === 0 ? 2 : 1)}
              </span>
              <CommentStateGlyph state={state} onClick={open} />
            </>
          }
        />
      ))}
    </div>
  ),
};
