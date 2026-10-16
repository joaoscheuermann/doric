// The `papercraft_preview` tool: publish a visual change as a live preview
// node of the conversation instead of describing it.
//
// Without `artifact_id` it creates the `preview` artifact at revision 1; with
// one it publishes that preview's next revision (`artifacts/v1.revise`), so the
// earlier node and its comments stay in the conversation. Either way it reads
// the source once and builds the payload once — an `html` source as its
// markup, a `component` compiled into a live module (`index.js`, `index.css`)
// beside its fallback markup, a compile error failing the call before
// anything is published: the revision's entries
// (`path` + `sha256`) and the bytes that hash to them travel together, so the
// registry records the entries in the event and writes the bytes into the work
// copy (`/workspace/.doric/artifacts/<artifactId>/`) without asking the kind
// to read the source a second time.
//
// It returns the resolved state of the preview, not a write confirmation: the
// revision now current, the unresolved comments of the artifact with their
// anchors and the replies each thread already holds — read from `comments/v1`
// in the call's scope, so a round of adjustments does not depend on the user
// repeating them in the prompt, and the agent sees the conversation — and
// the review the Project's policy asks for. Under `proceed` (the default) the
// agent implements the change right away; under `request` the tool still
// publishes and answers at once, saying the approval is pending: it never
// blocks waiting for it.

import { ContractError } from 'bundle/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import {
  ARTIFACT_TARGET_KIND,
  type ArtifactRecord,
  ArtifactsV1,
  type ArtifactTarget,
  type Comment,
  CommentsV1,
  commentAnchorSchema,
  PREVIEW_KIND,
  previewFileSchema,
  previewSourceSchema,
} from '../../contracts/index.js';
import { snapshotPreview } from '../previews.js';

/** The tool name the model calls; fixed by the design. */
export const PAPERCRAFT_PREVIEW_TOOL = 'papercraft_preview';

/** The global model-visible position, the next free band after `threads`. */
export const PAPERCRAFT_PREVIEW_ORDER = 1700;

const description = [
  'Publish a visual change as a live preview node of the conversation, built from real',
  'code, instead of describing it. Use it when the change is easier to judge by looking',
  'than by reading a diff: layout, spacing, a component states, a new screen. Without',
  '`artifact_id` it creates a preview; with the `artifact_id` of an earlier preview it',
  "publishes that preview's next revision. It returns the revision, the unresolved comments",
  'with their anchors and replies, and the review state. The preview is a window, not a',
  'gate: publish it and implement the change, unless the review state says an approval is',
  'pending. Answer each comment with `comment_reply`, resolving it when it is done.',
].join(' ');

const targetSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    /** The first and last line the anchor covers. */
    lines: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .optional(),
    snippet: z.string().optional(),
  })
  .strict();

export const input = z
  .object({
    /** Absent: a new preview. Present: the next revision of that preview. */
    artifact_id: z.string().min(1).optional(),
    /** Required for a new preview; a revision keeps the previous title. */
    title: z.string().min(1).optional(),
    /** Required for a new preview; a revision keeps the previous source. */
    source: previewSourceSchema.optional(),
    /** Required for a new preview; a revision rebuilds the previous path. */
    path: z.string().min(1).optional(),
    entry: z.string().min(1).optional(),
    targets: z.array(targetSchema).optional(),
    /** The note of a new preview, or the change note of a revision. */
    notes: z.string().optional(),
  })
  .strict();

export type PreviewToolInput = z.output<typeof input>;

/** One reply of a comment's thread, in the order of the log. */
const replySchema = z
  .object({
    commentId: z.string(),
    author: z.string().optional(),
    text: z.string(),
  })
  .strict();

/**
 * One comment the agent still has to address — an unresolved root — with
 * where it points and the replies its thread holds (the agent's own answers
 * and the reader's follow-ups).
 */
const pendingCommentSchema = z
  .object({
    commentId: z.string(),
    revision: z.number().int().positive().optional(),
    text: z.string(),
    author: z.string().optional(),
    anchor: commentAnchorSchema,
    replies: z.array(replySchema),
  })
  .strict();

export type PendingComment = z.output<typeof pendingCommentSchema>;

/** What the model reads back: the state of the preview, not a confirmation. */
export const output = z
  .object({
    artifactId: z.string().min(1),
    revision: z.number().int().positive(),
    revisions: z.number().int().positive(),
    title: z.string(),
    source: previewSourceSchema,
    path: z.string(),
    files: z.array(previewFileSchema),
    /** The unresolved root comments of every revision, in the order of the log. */
    comments: z.array(pendingCommentSchema),
    review: z
      .object({
        policy: z.enum(['proceed', 'request']),
        /** Under `request`: whether this revision still waits for approval. */
        pending: z.boolean(),
      })
      .strict(),
    /** What could not be read, when part of the state is missing. */
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export type PreviewToolOutput = z.output<typeof output>;

/** The anchors a preview without explicit targets names: the source itself. */
export const defaultTargets = (input: {
  readonly path: string;
  readonly targets?: readonly ArtifactTarget[];
}): readonly ArtifactTarget[] => input.targets ?? [{ path: input.path }];

const invalid = (message: string): ContractError =>
  new ContractError('invalid_input', message);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The comments the agent still has to address: every unresolved root, with
 * the replies that answer it. A reply is never pending on its own — its root
 * is — and resolving the root closes the thread.
 */
export const pendingOf = (comments: readonly Comment[]): PendingComment[] =>
  comments
    .filter((comment) => comment.inReplyTo === undefined && !comment.resolved)
    .map((root) => ({
      commentId: root.commentId,
      ...(root.target.revision === undefined
        ? {}
        : { revision: root.target.revision }),
      text: root.text,
      ...(root.author === undefined ? {} : { author: root.author }),
      anchor: root.target.anchor,
      replies: comments
        .filter((reply) => reply.inReplyTo === root.commentId)
        .map((reply) => ({
          commentId: reply.commentId,
          ...(reply.author === undefined ? {} : { author: reply.author }),
          text: reply.text,
        })),
    }));

export const tool = defineTool({
  name: PAPERCRAFT_PREVIEW_TOOL,
  description,
  input,
  output,
  execute: async (payload, call, services) => {
    const artifacts = services.use(ArtifactsV1, call.scope);
    const previous =
      payload.artifact_id === undefined
        ? undefined
        : await artifacts.read({ artifactId: payload.artifact_id }, call);

    if (payload.artifact_id !== undefined && previous === undefined) {
      throw invalid(
        `There is no preview "${payload.artifact_id}" to revise; omit artifact_id to create one.`,
      );
    }

    if (previous !== undefined && previous.kind !== PREVIEW_KIND) {
      throw invalid(
        `The artifact "${previous.artifactId}" is a "${previous.kind}", not a preview.`,
      );
    }

    const title = payload.title ?? previous?.title;
    const source = payload.source ?? previous?.source;
    const path = payload.path ?? previous?.path;
    const entry = payload.entry ?? previous?.entry;

    if (title === undefined || source === undefined || path === undefined) {
      throw invalid('A new preview needs a title, a source and a path.');
    }

    // One snapshot, before anything is registered: an unreadable or
    // non-textual source, or a component that does not compile, fails here
    // and leaves the registry untouched.
    const built = await snapshotPreview(services, call, {
      source,
      path,
      ...(entry === undefined ? {} : { entry }),
    });
    const revision = { entries: built.entries, files: built.files };

    const record: ArtifactRecord =
      previous === undefined
        ? await artifacts.create(
            {
              kind: PREVIEW_KIND,
              title,
              targets: defaultTargets({ path, targets: payload.targets }),
              source,
              path,
              ...(entry === undefined ? {} : { entry }),
              ...(payload.notes === undefined ? {} : { notes: payload.notes }),
              ...revision,
            },
            call,
          )
        : await artifacts.revise(
            {
              artifactId: previous.artifactId,
              ...(payload.notes === undefined
                ? {}
                : { changeNote: payload.notes }),
              // Explicit anchors win; a new path names itself; otherwise the
              // previous revision's anchors carry over.
              ...(payload.targets !== undefined
                ? { targets: payload.targets }
                : payload.path !== undefined && payload.path !== previous.path
                  ? { targets: [{ path }] }
                  : {}),
              source,
              path,
              ...(entry === undefined ? {} : { entry }),
              ...revision,
            },
            call,
          );

    // The rest of the state is a reading: the revision is already published,
    // so a failed read is reported, never turned into a failed call the model
    // would retry into a duplicate preview.
    const warnings: string[] = [...built.warnings];

    const comments = await services
      .use(CommentsV1, call.scope)
      .list(
        { target: { kind: ARTIFACT_TARGET_KIND, id: record.artifactId } },
        call,
      )
      .then(pendingOf)
      .catch((error: unknown) => {
        warnings.push(`The comments could not be read: ${messageOf(error)}`);

        return [];
      });

    const policy = await artifacts
      .policy(call)
      .then((answer) => answer.policy)
      .catch((error: unknown) => {
        warnings.push(
          `The review policy could not be read: ${messageOf(error)}`,
        );

        return 'proceed' as const;
      });

    return {
      artifactId: record.artifactId,
      revision: record.revision,
      revisions: record.revisions,
      title: record.title,
      source,
      path,
      files: [...built.entries],
      comments,
      // A revision just published cannot have been approved yet.
      review: { policy, pending: policy === 'request' },
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  },
});

// The tool target kind the preview comments are anchored with, re-exported so
// the fake host and tests name it once.
export { ARTIFACT_TARGET_KIND };
