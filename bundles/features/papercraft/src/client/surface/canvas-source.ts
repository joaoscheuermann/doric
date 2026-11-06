// What one canvas shows (D26): an artifact's revisions (the old path, stages
// 2–3) or a papercraft program's revisions by its identity in one Thread.
// Frame memory, snapshots, live frames, controllers and the canvas registry
// are keyed by `canvasIdOf`; comment lists and pins compare `targetKeyOf`.

export type CanvasSource =
  | { readonly kind: 'artifact'; readonly artifactId: string }
  | {
      readonly kind: 'program';
      readonly threadId: string;
      readonly identity: string;
    };

/**
 * The canvas id: the artifact id, unchanged, so the old path's keys do not
 * change; or `program:<threadId>/<identity>`, so the same identity in two
 * Threads gives two ids. Pure; never throws.
 */
export const canvasIdOf = (source: CanvasSource): string =>
  source.kind === 'artifact'
    ? source.artifactId
    : `program:${source.threadId}/${source.identity}`;

/**
 * The comment target a canvas lists: `{ kind: 'artifact', id: artifactId }`,
 * or `{ kind: 'papercraft-program', id: identity }`. Pure; never throws.
 */
export const targetKeyOf = (
  source: CanvasSource,
): { readonly kind: string; readonly id: string } =>
  source.kind === 'artifact'
    ? { kind: 'artifact', id: source.artifactId }
    : { kind: 'papercraft-program', id: source.identity };
