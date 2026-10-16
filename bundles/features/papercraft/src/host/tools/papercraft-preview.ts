// The `papercraft_preview` tool: publish a visual change as a live preview
// node of the conversation instead of describing it.
//
// It derives the built payload (`papercraft.previews/v1.build`), creates the
// `preview` artifact at revision 1 through `artifacts/v1` — which owns the
// registry, the identity and the `artifacts.created/v1` event — and returns the
// resolved preview state (`papercraft.previews/v1.read`), not a write
// confirmation. The revision's entries (`path` + `sha256`) travel with the
// `create` — the registry records them in the event and in the work copy's
// manifest, never the bytes — and the kind's payload rides along, so the
// registry asks this bundle's own materialization for the revision's bytes and
// writes them into the work copy: `artifacts/v1.read` then serves the entries in
// base64, as `doric.catalog/v1.artifact` does. Under the default `proceed`
// policy it never blocks; under `request` the agent still publishes and the
// window's `Autorizar` writes the approval.

import { defineTool } from 'tool';
import { z } from 'zod';

import {
  ARTIFACT_TARGET_KIND,
  ArtifactsV1,
  type ArtifactTarget,
  PapercraftPreviewsV1,
  PREVIEW_KIND,
  previewSourceSchema,
  previewStateSchema,
} from '../../contracts/index.js';

/** The tool name the model calls; fixed by the design. */
export const PAPERCRAFT_PREVIEW_TOOL = 'papercraft_preview';

/** The global model-visible position, the next free band after `threads`. */
export const PAPERCRAFT_PREVIEW_ORDER = 1700;

const description = [
  'Publish a visual change as a live preview node of the conversation, built from real',
  'code, instead of describing it. Use it when the change is easier to judge by looking',
  'than by reading a diff: layout, spacing, a component states, a new screen. The preview',
  'is a window, not a gate: publish it and implement the change; the comments steer.',
].join(' ');

export const input = z
  .object({
    title: z.string().min(1),
    source: previewSourceSchema,
    path: z.string().min(1),
    entry: z.string().min(1).optional(),
    targets: z
      .array(
        z
          .object({
            path: z.string().min(1),
            line: z.number().int().positive().optional(),
            snippet: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    notes: z.string().optional(),
  })
  .strict();

export type PreviewToolInput = z.output<typeof input>;

export const output = previewStateSchema;

/** The anchors a preview without explicit targets names: the source itself. */
export const defaultTargets = (
  input: PreviewToolInput,
): readonly ArtifactTarget[] => input.targets ?? [{ path: input.path }];

export const tool = defineTool({
  name: PAPERCRAFT_PREVIEW_TOOL,
  description,
  input,
  output,
  execute: async (payload, call, services) => {
    const previews = services.use(PapercraftPreviewsV1, call.scope);

    // Build first: an unreadable or non-textual source fails before anything is
    // registered as an artifact.
    const built = await previews.build(
      {
        path: payload.path,
        source: payload.source,
        ...(payload.entry === undefined ? {} : { entry: payload.entry }),
      },
      call,
    );

    // The revision's entries and the kind's payload, which the structural copy
    // of `artifacts/v1` this bundle keeps predates: they are passed through —
    // the registry's own loose input schema takes both — so the event carries
    // the entries, and the registry asks this bundle's materialization (the
    // same derivation `build` ran) for the bytes it writes into the work copy.
    const revision = {
      entries: built.files,
      payload: {
        source: payload.source,
        path: payload.path,
        ...(payload.entry === undefined ? {} : { entry: payload.entry }),
      },
    } as Record<string, unknown>;

    const record = await services.use(ArtifactsV1, call.scope).create(
      {
        kind: PREVIEW_KIND,
        title: payload.title,
        targets: defaultTargets(payload),
        source: payload.source,
        path: payload.path,
        ...(payload.entry === undefined ? {} : { entry: payload.entry }),
        ...(payload.notes === undefined ? {} : { notes: payload.notes }),
        ...revision,
      },
      call,
    );

    const state = await previews.read(
      { artifactId: record.artifactId, revision: record.revision },
      call,
    );

    if (state === undefined) {
      throw new Error(
        `The preview artifact "${record.artifactId}" was not readable after it was created.`,
      );
    }

    return state;
  },
});

// The tool target kind the preview comments are anchored with, re-exported so
// the fake host and tests name it once.
export { ARTIFACT_TARGET_KIND };
