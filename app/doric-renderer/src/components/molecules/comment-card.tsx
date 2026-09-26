/**
 * The read-only half of a comment, as a person's own turn shows it: the span the
 * comment points at, quoted, and the words about it underneath.
 *
 * Nothing here is interactive — the card is the record of a comment, not the
 * place it is edited — so it renders only what it is given.
 */
export function CommentCard({
  quote,
  body,
}: {
  readonly quote: string;
  readonly body: string;
}) {
  return (
    <div className="doric-comment-card-body">
      <p className="doric-comment-quote">“{quote}”</p>
      <div className="doric-comment-body">
        <span
          aria-hidden
          className="doric-avatar doric-avatar-sm"
          data-kind="user"
        />
        <p>{body}</p>
      </div>
    </div>
  );
}
