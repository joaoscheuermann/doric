// The `preview` artifact kind: its declaration for `artifact.kind/v1`, as the
// `artifacts` bundle's registry takes it — the name, the zod schema of its
// payload, its own `materialize` and the `blockType` its renderer draws.
//
// The payload is what the `papercraft_preview` tool sends: the source kind,
// the Project-relative source path and, for a `component`, its entry. The
// materialization is the bundle's own path A over `files/v1`: the source is
// read, derived into self-contained markup and hashed into the revision's
// entries, and the markup's bytes are handed back so the registry writes them
// into the work copy — `read` then serves them, and the event carries the hash
// only. The `blockType` is the one the bundle's own projector and renderer
// speak (`papercraft.preview/v1`): a kind that declares one owns its node
// surface, so the `artifacts` bundle's client leaves the `artifacts.*` pair to
// this bundle's client.
//
// The types here are structural copies of the `artifacts` bundle's contracts
// (`bundles/features/artifacts/src/contracts/index.ts`), as this bundle keeps
// for `artifacts/v1`, `files/v1` and `comments/v1`: the registry's kind
// contract carries the provider, and this bundle must not import it at compile
// time.

import type { Call, Services } from 'bundle/contracts';
import { z } from 'zod';

import {
  PREVIEW_BLOCK_TYPE,
  type previewFileSchema,
  previewSourceSchema,
} from '../contracts/index.js';
import { builtFiles, deriveMarkup, readSource } from './previews.js';

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

    const content = await readSource(services, call, payload.path);
    const markup = deriveMarkup(payload.source, payload.path, content);
    const { files: entries } = builtFiles(markup);

    return {
      entries,
      targets: [{ path: payload.path }],
      files: entries.map((entry) => ({
        path: entry.path,
        base64: Buffer.from(markup, 'utf8').toString('base64'),
      })),
    };
  },
  blockType: PREVIEW_BLOCK_TYPE,
});
