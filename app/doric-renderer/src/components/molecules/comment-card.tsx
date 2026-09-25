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
    <div className="flex flex-col gap-1">
      <p className="border-l-2 border-border pl-2 text-sm text-muted-foreground">
        “{quote}”
      </p>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="doric-avatar doric-avatar-sm"
          data-kind="user"
        />
        <p className="text-sm">{body}</p>
      </div>
    </div>
  );
}
