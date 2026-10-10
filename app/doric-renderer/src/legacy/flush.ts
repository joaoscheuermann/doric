import type { FlushParticipants } from 'desktop-client';

/**
 * The legacy flush participants of the close protocol. The settings view's
 * `window.doric.settings.onFlush` listeners are kept and run by the preload in
 * the same flush phase, so the renderer adds none of its own; the seam exists
 * for the stage-9 handoff.
 */
export const legacyFlushListeners: FlushParticipants = () => [];
