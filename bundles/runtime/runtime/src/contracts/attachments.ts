// Image attachments: bytes a reader or a tool hands the model, kept once as a
// content-addressed blob and named in text by a Markdown image line,
//
//   ![cat.png](doric-attachment:sha256-<64 hex>)
//
// so a prompt, a queued input and a tool result stay text everywhere they
// travel — events, the queue, history — and the image keeps its place among
// the words. The executor reads the bytes back only when it calls the model,
// and only for an attachment its Project holds; any other line stays text.

import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/** The image types a model reads, by their media type. */
export const attachmentMediaTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type AttachmentMediaType = (typeof attachmentMediaTypes)[number];

/** The largest image one attachment may carry, in bytes. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** The longest name an attachment keeps, in characters. */
export const ATTACHMENT_MAX_NAME = 200;

const SCHEME = 'doric-attachment:';

/** The reference a line names: `sha256-<hex>`, the blob's hash spelled for a URL. */
export const attachmentIdSchema = z
  .string()
  .regex(/^sha256-[0-9a-f]{64}$/u, 'An attachment id is sha256-<64 hex>.');

export const attachmentMediaTypeSchema = z.enum(attachmentMediaTypes);

/** One stored attachment, as the host answers it. */
export const attachmentSchema = z
  .object({
    id: attachmentIdSchema,
    name: z.string().min(1).max(ATTACHMENT_MAX_NAME),
    mediaType: attachmentMediaTypeSchema,
    size: z.number().int().positive(),
  })
  .strict();

export type Attachment = z.output<typeof attachmentSchema>;

/** One attachment's bytes, base64, with what they are. */
export const attachmentContentSchema = attachmentSchema
  .extend({ bytes: z.string() })
  .strict();

export type AttachmentContent = z.output<typeof attachmentContentSchema>;

/** The blob hash an attachment id names: `sha256-<hex>` is `sha256:<hex>`. */
export const attachmentBlobHash = (id: string): string =>
  `sha256:${id.slice('sha256-'.length)}`;

/** The attachment id of a blob hash: `sha256:<hex>` is `sha256-<hex>`. */
export const attachmentIdOf = (hash: string): string =>
  `sha256-${hash.slice('sha256:'.length)}`;

/**
 * A name as a reference line writes it: one line, without the brackets that
 * would end its alt text, and never empty.
 */
export const attachmentLabel = (name: string): string => {
  const label = name
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[[\]]/gu, '')
    .trim()
    .slice(0, ATTACHMENT_MAX_NAME);
  return label === '' ? 'image' : label;
};

/** The Markdown line that names an attachment in text. */
export const attachmentReference = (name: string, id: string): string =>
  `![${attachmentLabel(name)}](${SCHEME}${id})`;

/** One reference found in a text, with where it sits. */
export interface AttachmentReference {
  readonly name: string;
  readonly id: string;
  /** Offset of the `!` that starts it. */
  readonly start: number;
  /** Offset just past the `)` that ends it. */
  readonly end: number;
}

const referencePattern = (): RegExp =>
  /!\[([^\]\n]*)\]\(doric-attachment:(sha256-[0-9a-f]{64})\)/gu;

/** Every reference a text names, in the order it names them. */
export const attachmentReferences = (
  text: string,
): readonly AttachmentReference[] =>
  [...text.matchAll(referencePattern())].map((match) => ({
    name: match[1] ?? '',
    id: match[2] ?? '',
    start: match.index,
    end: match.index + match[0].length,
  }));

/** The single reference a line is, when the line holds nothing else. */
export const attachmentLine = (
  line: string,
): AttachmentReference | undefined => {
  const trimmed = line.trim();
  const [only] = attachmentReferences(trimmed);
  return only !== undefined && only.start === 0 && only.end === trimmed.length
    ? only
    : undefined;
};

/** The text with every reference as a short `[name]` placeholder. */
export const withAttachmentPlaceholders = (text: string): string =>
  text.replace(referencePattern(), (_line, name: string) => `[${name}]`);

/**
 * The media type the bytes start with, or undefined when they are not an image
 * a model reads: what a file claims to be does not decide it.
 */
export const sniffImageMediaType = (
  bytes: Uint8Array,
): AttachmentMediaType | undefined => {
  const starts = (...signature: readonly number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  return undefined;
};

/** What an attach receives: the bytes, base64, and the name to show. */
export const attachInputSchema = z
  .object({
    name: z.string(),
    bytes: z.string(),
  })
  .strict();

export type AttachInput = z.output<typeof attachInputSchema>;

/**
 * runtime.attachments/v1: the images of the calling Project. `attach` keeps
 * an image for the Thread of `call.scope.threadId`, deleted with that Thread
 * or its Project; `read` answers for `call.scope.projectId` or the Project of
 * `call.scope.threadId`, so every Thread of a Project reads its images.
 */
export interface RuntimeAttachments {
  /**
   * Keeps an image for the Project and answers its attachment. It refuses
   * (`invalid_input`) bytes that are not a PNG, JPEG, WebP or GIF image, or
   * that are empty or larger than ATTACHMENT_MAX_BYTES. Attaching the same
   * bytes again answers the same id.
   */
  attach(input: AttachInput, call?: CallArg): Promise<Attachment>;
  /** One attachment of the Project, bytes and all; undefined when it holds none by that id. */
  read(
    input: { readonly id: string },
    call?: CallArg,
  ): Promise<AttachmentContent | undefined>;
}

export const runtimeAttachmentsMethods = {
  attach: { input: attachInputSchema, output: attachmentSchema },
  read: {
    input: z.object({ id: z.string() }).strict(),
    output: attachmentContentSchema.optional(),
  },
} as const;

export const RuntimeAttachmentsV1 = ref<RuntimeAttachments>(
  'runtime.attachments/v1',
);

export const attachmentsScopeMessage =
  'runtime.attachments/v1 needs a Project or Thread scope.';

export const attachScopeMessage =
  'runtime.attachments/v1.attach needs a Thread scope.';
