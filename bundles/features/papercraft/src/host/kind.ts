// The `preview` artifact kind: its declaration for `artifact.kind/v1`, as the
// `artifacts` bundle's registry takes it — the name, the zod schema of its
// payload, its own `materialize`, and the `blockType`/`bodyTag` of its body.
//
// The payload is what the `papercraft_preview` tool sends: the source kind,
// the Project-relative source path and, for a `component`, the export to
// mount. The materialization is the bundle's own build over `files/v1`: an
// `html` source becomes self-contained markup (path A), a `component` is
// compiled into `index.js` and `index.css` beside its fallback markup (path
// B); each file is hashed into the revision's entries, and the bytes are
// handed back so the registry writes them into the work copy — `read` then
// serves them, and the event carries the hashes only. "The frame is the registry's, the body is the kind's": the registry's
// frame draws the title, the revision reading, the review state and the comment
// gesture, and creates `<papercraft-preview>` (`bodyTag`) inside it with its
// block (`type` = `papercraft.preview/v1`, `data` = the frame's data) — the
// canvas is the body.
//
// The types here are structural copies of the `artifacts` bundle's contracts
// (`bundles/features/artifacts/src/contracts/index.ts`), as this bundle keeps
// for `artifacts/v1`, `files/v1` and `comments/v1`: the registry's kind
// contract carries the provider, and this bundle must not import it at compile
// time.

import type { Call, Services } from 'bundle/contracts';
import { z } from 'zod';

import {
  PAPERCRAFT_PREVIEW_TAG,
  PREVIEW_BLOCK_TYPE,
  type previewFileSchema,
  previewSourceSchema,
} from '../contracts/index.js';
import { snapshotPreview } from './previews.js';

/**
 * The closed schema of what a `preview` payload is: the source kind, the
 * Project-relative path of the source and, when the source is a component,
 * its entry.
 */
export const previewKindPayloadSchema = z
  .object({
    source: previewSourceSchema,
    path: z.string().min(1),
    entry: z.string().min(1).optional(),
  })
  .strict();

/**
 * What the kind's materialization answers, as the registry takes it: the
 * entries of the revision, the anchors it declares and the bytes to write
 * into the work copy.
 */
export interface PreviewMaterialization {
  readonly entries: readonly z.output<typeof previewFileSchema>[];
  readonly targets?: readonly { readonly path: string }[];
  readonly files?: readonly {
    readonly path: string;
    readonly base64: string;
  }[];
}

/** The kind's own derivation of a revision from its payload, structural copy. */
export type PreviewKindMaterialize = (
  input: {
    readonly payload: unknown;
    readonly artifactId: string;
    readonly revision: number;
    readonly title: string;
  },
  call?: Call,
) => Promise<PreviewMaterialization> | PreviewMaterialization;

/** The `preview` kind, declared for `artifact.kind/v1`. */
export const previewKind = (
  services: Services,
): {
  readonly id: 'preview';
  readonly title: 'Preview';
  readonly payload: typeof previewKindPayloadSchema;
  readonly materialize: PreviewKindMaterialize;
  readonly blockType: typeof PREVIEW_BLOCK_TYPE;
  readonly bodyTag: typeof PAPERCRAFT_PREVIEW_TAG;
  readonly header: 'body';
} => ({
  id: 'preview',
  title: 'Preview',
  payload: previewKindPayloadSchema,
  materialize: async (input, call) => {
    const payload = previewKindPayloadSchema.parse(input.payload);

    if (call === undefined) {
      // The registry always passes the calling prompt's `call`; without it
      // there is no scope to read the Project's source from.
      throw new Error(
        'The preview materialization needs the call of its caller.',
      );
    }

    const { entries, files } = await snapshotPreview(services, call, payload);

    return { entries, targets: [{ path: payload.path }], files };
  },
  blockType: PREVIEW_BLOCK_TYPE,
  bodyTag: PAPERCRAFT_PREVIEW_TAG,
  // The canvas overlays its own header (title, revision, comment control):
  // the frame draws no bar, and keeps `Autorizar` and the revisions below.
  header: 'body',
});
