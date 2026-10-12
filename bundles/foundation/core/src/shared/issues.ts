/** A validation issue as zod reports it. */
interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * The text of an `invalid_input` refusal: each issue as `path: message`,
 * joined with `; `. Shared by every core facade so their messages agree.
 */
export const describeIssues = (error: {
  readonly issues: readonly Issue[];
}): string =>
  error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}`,
    )
    .join('; ');
