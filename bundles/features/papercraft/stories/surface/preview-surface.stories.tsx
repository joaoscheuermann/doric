import { type ComponentType, useState } from 'react';

import {
  PreviewSurface,
  type SurfaceMode,
} from '../../src/client/surface/preview-surface.js';
import { CanvasArea } from '../support/frame.js';
import { ARTIFACT_ID, checkoutMarkup } from '../support/preview.js';

const cached = async (): Promise<void> => undefined;
const refused = (): Promise<void> => Promise.reject(new Error('hash_mismatch'));

/** The surface, with the mode it reports, as the frame reads it. */
function Surface(
  props: Partial<Parameters<typeof PreviewSurface>[0]> & {
    readonly markup: string | undefined;
  },
) {
  const [mode, setMode] = useState<SurfaceMode | undefined>(undefined);

  return (
    <>
      <PreviewSurface
        artifactId={ARTIFACT_ID}
        revision={2}
        height={440}
        onMode={setMode}
        {...props}
      />
      <span className="absolute right-2 bottom-2 rounded bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
        {mode ?? '…'}
      </span>
    </>
  );
}

export default {
  title: 'Papercraft/Surface/Preview surface',
  component: PreviewSurface,
  decorators: [
    (Story: ComponentType) => (
      <CanvasArea>
        <Story />
      </CanvasArea>
    ),
  ],
};

/** Path A: the revision names no module, so its built markup is mounted. */
export const Markup = {
  render: () => <Surface markup={checkoutMarkup(2)} entries={['index.html']} />,
};

/** Path B: the revision's module is cached, then loaded in the frame. */
export const Module = {
  render: () => (
    <Surface
      markup={checkoutMarkup(2)}
      entries={['index.html', 'index.js']}
      ensure={cached}
    />
  ),
};

/** The revision could not be cached: the markup of path A stands in. */
export const ModuleFallback = {
  render: () => (
    <Surface
      markup={checkoutMarkup(2)}
      entries={['index.html', 'index.js']}
      ensure={refused}
    />
  ),
};

/** The comment tool owns the pointer: no element's cursor wins. */
export const CursorLocked = {
  render: () => (
    <Surface
      markup={checkoutMarkup(2)}
      entries={['index.html']}
      cursor={{ locked: true, cursor: 'crosshair' }}
    />
  ),
};

/** Before `papercraft.previews/v1` answered: an empty host. */
export const NotRead = {
  render: () => <Surface markup={undefined} entries={[]} />,
};
