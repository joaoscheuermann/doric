// `desktop/ui/canvas`: the canvas pieces every artifact frame shares — the
// viewport, the pins, the threads, the comment flow and the chrome — generic
// in the owner's anchor type. One instance per window (the import map), so the
// Thread log is shared by every bundle.
export * from './avatar.js';
export * from './comment-field.js';
export * from './comment-flow.js';
export * from './comment-overlay.js';
export * from './fit.js';
export * from './footer.js';
export * from './geometry.js';
export * from './gestures.js';
export * from './header.js';
export * from './modal.js';
export * from './pins-layer.js';
export * from './theme.js';
export * from './thread-log.js';
export * from './thread-open.js';
export * from './thread-popover.js';
export * from './threads.js';
export * from './threads-view.js';
export * from './toolbar.js';
export * from './viewport.js';
