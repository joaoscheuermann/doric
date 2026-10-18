import { type ComponentType, useState } from 'react';

import {
  type PapercraftModule,
  PreviewSurface,
  type SurfaceMode,
} from '../../src/client/surface/preview-surface.js';
import { CanvasArea } from '../support/frame.js';
import { ARTIFACT_ID, checkoutMarkup } from '../support/preview.js';

/**
 * A compiled module of path B, as the import map would hand it: it mounts
 * its own DOM into the content root and returns its unmount.
 */
const checkoutModule: PapercraftModule = {
  mount: (root, { theme }) => {
    const card = document.createElement('section');
    card.setAttribute(
      'style',
      'margin: 48px auto; width: 320px; padding: 20px; border-radius: 12px; border: 1px solid var(--border); background: var(--background); color: var(--foreground); font-family: system-ui, sans-serif; display: grid; gap: 12px;',
    );
    card.innerHTML = `<strong>Order summary</strong><span style="color: var(--muted-foreground); font-size: 13px">Mounted by the revision's module · ${theme} theme</span><button style="font: inherit; border: 0; border-radius: 8px; padding: 10px 14px; background: var(--primary); color: var(--primary-foreground)">Pay $144.00</button>`;
    root.replaceChildren(card);

    return () => root.replaceChildren();
  },
};

const loadModule = async (): Promise<unknown> => checkoutModule;
const loadNothing = (): Promise<unknown> =>
  Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
const cached = async (): Promise<void> => undefined;

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

/** Path B: the revision's module is cached, imported and mounted. */
export const Module = {
  render: () => (
    <Surface
      markup={checkoutMarkup(2)}
      entries={['index.html', 'index.js']}
      ensure={cached}
      load={loadModule}
    />
  ),
};

/** The module did not load: the markup of path A stands in. */
export const ModuleFallback = {
  render: () => (
    <Surface
      markup={checkoutMarkup(2)}
      entries={['index.html', 'index.js']}
      ensure={cached}
      load={loadNothing}
    />
  ),
};

/** The comment tool owns the pointer: no element's cursor wins. */
export const CursorLocked = {
  render: () => (
    <Surface markup={checkoutMarkup(2)} entries={['index.html']} lockCursor />
  ),
};

/** Before `papercraft.previews/v1` answered: an empty host. */
export const NotRead = {
  render: () => <Surface markup={undefined} entries={[]} />,
};
