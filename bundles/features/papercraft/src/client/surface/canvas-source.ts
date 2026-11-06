// What one canvas shows (D26): a papercraft program's revisions by its
// identity in one Thread. Frame memory, snapshots, live frames, controllers
// and the canvas registry are keyed by `canvasIdOf`; comment lists and pins
// compare `targetKeyOf`.

export type CanvasSource = {
  readonly kind: 'program';
  readonly threadId: string;
  readonly identity: string;
};

/**
 * The canvas id: `program:<threadId>/<identity>`, so the same identity in two
 * Threads gives two ids. Pure; never throws.
 */
export const canvasIdOf = (source: CanvasSource): string =>
  `program:${source.threadId}/${source.identity}`;

/**
 * The comment target a canvas lists: `{ kind: 'papercraft-program', id:
 * identity }`. Pure; never throws.
 */
export const targetKeyOf = (
  source: CanvasSource,
): { readonly kind: string; readonly id: string } => ({
  kind: 'papercraft-program',
  id: source.identity,
});
