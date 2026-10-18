import {
  CommentPin,
  type CommentPinSize,
  type CommentPinState,
} from 'desktop/ui/comment-pin';

export default {
  title: 'desktop/ui/Comment pin',
  component: CommentPin,
};

const STATES: readonly CommentPinState[] = ['open', 'await', 'done', 'draft'];

const SIZES: readonly CommentPinSize[] = ['sm', 'md', 'lg'];

/** Every state at the pin's default size (`md`). */
export const States = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {STATES.map((state) => (
        <CommentPin key={state} state={state}>
          1
        </CommentPin>
      ))}
    </div>
  ),
};

/** The three sizes side by side, each with its number. */
export const Sizes = {
  render: () => (
    <div className="flex flex-wrap items-end gap-3">
      {SIZES.map((size) => (
        <CommentPin key={size} size={size}>
          1
        </CommentPin>
      ))}
    </div>
  ),
};

/** Every state at every size: what each surface can draw. */
export const StatesAndSizes = {
  render: () => (
    <div className="flex flex-col gap-4">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-wrap items-center gap-3">
          <span className="w-6 text-xs text-muted-foreground">{size}</span>
          {STATES.map((state) => (
            <CommentPin key={state} size={size} state={state}>
              1
            </CommentPin>
          ))}
        </div>
      ))}
    </div>
  ),
};
