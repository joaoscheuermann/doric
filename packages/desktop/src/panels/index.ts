// `desktop/ui/panels`: the panel widgets more than one bundle renders (file,
// changes, terminal and resource surfaces, and the layout's strips), served
// once per window so dnd-kit and the toast store are shared. Nothing here
// names a bundle's concept: a bundle passes its own rows, labels and colours.
export * from './expansion.js';
export * from './file-tree.js';
export * from './move-item.js';
export * from './panel-state.js';
export * from './read-feedback.js';
export * from './tab-strip.js';
export * from './toolbar-divider.js';
export * from './tree-guides.js';
export * from './tree-skeleton.js';
export * from './use-read-error.js';
export * from './use-tab-strip.js';
