import { useConversationActions } from '@/components/molecules/conversation-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { XIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

/**
 * The editable half of a comment: the person's own words about a span of an
 * answer. It is what a `CommentFieldNode` renders, so the words it holds reach
 * the surface through the actions context rather than through a node property —
 * a node carries data only, and a function is not data it could be rebuilt from.
 *
 * Outside a conversation there is nowhere for the words to go, so it renders
 * nothing.
 */
export function CommentField({
  commentId,
  autoFocus,
}: {
  readonly commentId: string;
  readonly autoFocus: boolean;
}) {
  const actions = useConversationActions();
  const input = useRef<HTMLInputElement>(null);

  // A comment written where the span is should not need a second click: the
  // field takes the caret on mount, at the end of whatever it already holds.
  useEffect(() => {
    const element = input.current;
    if (!autoFocus || element === null) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
  }, [autoFocus]);

  if (actions === undefined) return null;
  const body =
    actions.comments.find((comment) => comment.id === commentId)?.body ?? '';

  return (
    <div className="flex items-center gap-2 py-1">
      {/* The identicon is a CSS background the surface sets, so nothing of it is
          content. */}
      <span
        className="doric-avatar doric-avatar-sm"
        data-kind="user"
        aria-hidden
      />
      <Input
        ref={input}
        aria-label="Comment"
        placeholder="Comment"
        className="h-7"
        // The field's words live in the surface, so the input is the state rather
        // than a copy of it: a field rebuilt for any reason shows what the person
        // wrote, and there is nothing to reconcile between the two.
        value={body}
        onChange={(event) => actions.commentBody(commentId, event.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Remove comment"
        onClick={() => actions.removeComment(commentId)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
