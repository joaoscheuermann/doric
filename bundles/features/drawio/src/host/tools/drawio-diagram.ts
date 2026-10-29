import { posix } from 'node:path';

import { ContractError } from 'bundle/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import {
  ARTIFACT_TARGET_KIND,
  type ArtifactRecord,
  ArtifactsV1,
  artifactIdSchema,
  type Comment,
  CommentsV1,
  commentAnchorSchema,
  DIAGRAM_ENTRY,
  DIAGRAM_KIND,
  DRAWIO_DIAGRAM_TOOL,
  type LeasedSandbox,
  type PageSummary,
  pageSummarySchema,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
  USER_CHANGE_NOTE,
} from '../../contracts/index.js';
import { sha256 } from '../diagrams.js';
import { normalizeDiagram } from '../xml.js';

/** What the model reads; verbatim from the spec (`threads-drawio-diagrams.md`, the tool's description). */
const description = [
  'Publish a draw.io diagram as a node of the conversation, where the user sees it,',
  'comments on its shapes and connectors, and can edit it. Write the diagram as an',
  'uncompressed draw.io file (`mxfile`) under `.doric/artifacts/drafts/` and pass its',
  '`path`, absolute or relative to the current directory. Without `artifact_id` it',
  'creates a diagram. With the `artifact_id` of an earlier diagram it publishes the next',
  'revision from your draft at `path`: pass `base_revision`, the revision your draft',
  'holds. With `checkout: true`, it writes the latest revision to a new file at `path`',
  'and publishes nothing: use it when you need the content of a revision you did not',
  "write, such as the user's own edit. When a revision newer than `base_revision` exists,",
  "the call is refused and lists the newer revisions, the user's edits among them: check",
  'out the latest, reapply the changes you still want there, and call again. Keep cell',
  'ids stable across revisions and never reuse an id for another element. It returns the',
  'revision, the pages and the unresolved comments with their anchors and replies. Answer',
  'each comment with `comment_reply`.',
].join(' ');

/**
 * What the model sends. Shapes only: the combinations (`checkout` and
 * `base_revision` need `artifact_id`; `checkout` refuses `base_revision`,
 * `title` and `notes`; `artifact_id` without `checkout` needs `base_revision`;
 * a create needs `title`) are refused by `execute` with `invalid_input`
 * before anything is read.
 */
export const input = z
  .object({
    /** Absent: a new diagram. Present: the next revision, or the checkout, of that diagram. */
    artifact_id: artifactIdSchema.optional(),
    /** Required with `artifact_id` without `checkout`: the revision the draft holds. */
    base_revision: z.number().int().positive().optional(),
    /** With `artifact_id`: writes the latest revision to a new file at `path`. */
    checkout: z.boolean().optional(),
    /** Required on create; 1 to 120 characters. A revision keeps the title. */
    title: z.string().min(1).max(120).optional(),
    /** The `.drawio`, absolute or relative to the Thread's current directory. */
    path: z.string().min(1).max(512),
    /** The creation note, or the revision's change note; up to 2000 characters. */
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type DiagramToolInput = z.output<typeof input>;

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
 * where it points and the replies its thread holds.
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

/** What the model reads back: the state of the diagram, not a confirmation. */
export const output = z
  .object({
    artifactId: z.string(),
    revision: z.number().int().positive(),
    revisions: z.number().int().positive(),
    title: z.string(),
    /** Checkout only: the absolute path of the file written. */
    checkout: z.string().optional(),
    pages: z.array(pageSummarySchema),
    /** The unresolved roots, with their replies, in the order of the log. */
    comments: z.array(pendingCommentSchema),
    /** What could not be read after publishing (the comments); the call still succeeded. */
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export type DiagramToolOutput = z.output<typeof output>;

/**
 * The comments the agent still has to address: every unresolved root of the
 * given list, in its order, each with the replies whose `inReplyTo` is that
 * root, in their order. Replies and resolved roots are never entries of their
 * own; optional fields absent on the comment stay absent. Pure; never throws.
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

const invalid = (message: string): ContractError =>
  new ContractError('invalid_input', message);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Refuses the invalid input combinations, before anything is read. */
const checkCombination = (payload: DiagramToolInput): void => {
  if (payload.artifact_id === undefined) {
    if (payload.base_revision !== undefined || payload.checkout !== undefined) {
      throw invalid('checkout and base_revision need artifact_id.');
    }

    if (payload.title === undefined) {
      throw invalid('A new diagram needs a title.');
    }

    return;
  }

  if (payload.checkout === true) {
    if (
      payload.base_revision !== undefined ||
      payload.title !== undefined ||
      payload.notes !== undefined
    ) {
      throw invalid('checkout takes no base_revision, title or notes.');
    }

    return;
  }

  if (payload.base_revision === undefined) {
    throw invalid('Pass base_revision: the revision your draft holds.');
  }
};

/** How a newer revision shows in the base-rule refusal. */
const describeRevision = (record: ArtifactRecord): string =>
  `${record.revision} (${
    record.changeNote === USER_CHANGE_NOTE
      ? "the user's edit in the editor"
      : record.changeNote === undefined
        ? 'no note'
        : `"${record.changeNote}"`
  })`;

/** Reads the draft at `path` as UTF-8 text, refusing what is not a readable regular file. */
const readDraft = async (
  sandbox: LeasedSandbox,
  path: string,
): Promise<string> => {
  const regular = await sandbox.exec({ cmd: ['test', '-f', path] });

  if (regular.exitCode !== 0) {
    throw invalid(`Cannot read ${path}: not a regular file.`);
  }

  let bytes: Uint8Array;

  try {
    bytes = await sandbox.getFile(path);
  } catch (error) {
    throw invalid(`Cannot read ${path}: ${messageOf(error)}.`);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalid(`${path} is not valid UTF-8 text.`);
  }
};

/**
 * The `drawio_diagram` tool. Creates a diagram (revision 1), publishes the
 * next revision from a draft at `base_revision` = the latest, or checks the
 * latest revision out to a new file (publishing nothing). Every refusal is a
 * `ContractError('invalid_input', <model-readable message>)` and publishes
 * nothing; a missing lease or missing stored bytes is `unavailable` (with
 * `details.lease` for the lease). A failed comments read after publishing is
 * a warning, never a failure.
 */
export const tool = defineTool({
  name: DRAWIO_DIAGRAM_TOOL,
  description,
  input,
  output,
  execute: async (payload, call, services): Promise<DiagramToolOutput> => {
    checkCombination(payload);

    const artifacts = services.use(ArtifactsV1, call.scope);
    const artifactId = payload.artifact_id;

    const run = async (sandbox: LeasedSandbox): Promise<DiagramToolOutput> => {
      const latest =
        artifactId === undefined
          ? undefined
          : await artifacts.read({ artifactId }, call);

      if (artifactId !== undefined && latest === undefined) {
        throw invalid(
          `There is no diagram "${artifactId}"; omit artifact_id to create one.`,
        );
      }

      if (latest !== undefined && latest.kind !== DIAGRAM_KIND) {
        throw invalid(
          `The artifact "${latest.artifactId}" is a "${latest.kind}", not a diagram.`,
        );
      }

      const cwd = await services.use(RuntimeWorkspaceV1, call.scope).cwd(call);
      const path = posix.normalize(
        posix.isAbsolute(payload.path)
          ? payload.path
          : posix.join(cwd, payload.path),
      );
      const root = sandbox.root;

      if (path !== root && !path.startsWith(`${root}/`)) {
        throw invalid('The path is outside the Project.');
      }

      if (artifactId !== undefined) {
        const registry = posix.join(root, '.doric/artifacts', artifactId);

        if (path === registry || path.startsWith(`${registry}/`)) {
          throw invalid(
            "That is where the registry keeps this diagram's revisions; use checkout to get a copy.",
          );
        }
      }

      const warnings: string[] = [];
      const commentsOf = (id: string): Promise<PendingComment[]> =>
        services
          .use(CommentsV1, call.scope)
          .list({ target: { kind: ARTIFACT_TARGET_KIND, id } }, call)
          .then(pendingOf)
          .catch((error: unknown) => {
            warnings.push(
              `The comments could not be read: ${messageOf(error)}`,
            );

            return [];
          });

      if (latest !== undefined && payload.checkout === true) {
        const exists = await sandbox.exec({ cmd: ['test', '-e', path] });

        if (exists.exitCode === 0) {
          throw invalid(`${path} exists; checkout writes only a new file.`);
        }

        const base64 = latest.entries.find(
          (entry) => entry.path === DIAGRAM_ENTRY,
        )?.base64;

        if (base64 === undefined) {
          throw new ContractError(
            'unavailable',
            `The stored bytes of revision ${latest.revision} are gone.`,
          );
        }

        const xml = Buffer.from(base64, 'base64').toString('utf8');

        await sandbox.writeFile(path, xml);

        const stored = normalizeDiagram(xml);
        const pages: readonly PageSummary[] =
          'pages' in stored ? stored.pages : [];

        if ('error' in stored) {
          warnings.push(
            `The pages of revision ${latest.revision} could not be read: ${stored.error}`,
          );
        }

        const comments = await commentsOf(latest.artifactId);

        return {
          artifactId: latest.artifactId,
          revision: latest.revision,
          revisions: latest.revisions,
          title: latest.title,
          checkout: path,
          pages: [...pages],
          comments,
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      }

      const draft = await readDraft(sandbox, path);

      if (latest !== undefined && payload.base_revision !== undefined) {
        const base = payload.base_revision;
        const last = latest.revision;

        if (base > last) {
          throw invalid(
            `Revision ${base} does not exist; the latest is ${last}.`,
          );
        }

        if (base < last) {
          const newer = (
            await artifacts.revisions({ artifactId: latest.artifactId }, call)
          )
            .filter((record) => record.revision > base)
            .map(describeRevision)
            .join(', ');

          throw invalid(
            `Revision ${last} is newer than your base_revision ${base}. Newer revisions: ${newer}. Check out revision ${last} to a new path, reapply the changes you still want there, and call again with base_revision ${last}.`,
          );
        }
      }

      const normalized = normalizeDiagram(draft);

      if ('error' in normalized) {
        throw invalid(normalized.error);
      }

      if (payload.notes === USER_CHANGE_NOTE) {
        throw invalid("That note is reserved for the user's own edits.");
      }

      const hash = sha256(normalized.xml);

      if (
        latest?.entries.some(
          (entry) => entry.path === DIAGRAM_ENTRY && entry.sha256 === hash,
        )
      ) {
        throw invalid(
          `The diagram did not change since revision ${latest.revision}.`,
        );
      }

      const revision = {
        entries: [{ path: DIAGRAM_ENTRY, sha256: hash }],
        files: [
          {
            path: DIAGRAM_ENTRY,
            base64: Buffer.from(normalized.xml, 'utf8').toString('base64'),
          },
        ],
      };

      const title = latest?.title ?? payload.title;

      if (title === undefined) {
        throw invalid('A new diagram needs a title.');
      }

      const record: ArtifactRecord =
        latest === undefined
          ? await artifacts.create(
              {
                kind: DIAGRAM_KIND,
                title,
                path,
                ...(payload.notes === undefined
                  ? {}
                  : { notes: payload.notes }),
                ...revision,
              },
              call,
            )
          : await artifacts.revise(
              {
                artifactId: latest.artifactId,
                path,
                ...(payload.notes === undefined
                  ? {}
                  : { changeNote: payload.notes }),
                ...revision,
              },
              call,
            );

      const comments = await commentsOf(record.artifactId);

      return {
        artifactId: record.artifactId,
        revision: record.revision,
        revisions: record.revisions,
        title: record.title,
        pages: [...normalized.pages],
        comments,
        ...(warnings.length === 0 ? {} : { warnings }),
      };
    };

    const outcome = await services
      .use(RuntimeLeaseV1, call.scope)
      .withLease(run, call);

    if (outcome.status !== 'ready') {
      throw new ContractError(
        'unavailable',
        `The Project has no sandbox lease (${outcome.status}).`,
        { lease: outcome.status },
      );
    }

    return outcome.value;
  },
});
