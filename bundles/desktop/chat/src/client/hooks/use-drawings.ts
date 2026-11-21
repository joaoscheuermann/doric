import { useSyncExternalStore } from 'react';

import type { ToolRendererSpec } from '../../contracts/index.js';
import { chatViewsRegistry } from '../services/views.js';

/** No registration: frozen, so a window without one keeps a stable answer. */
const noTools: ReadonlyMap<string, ToolRendererSpec> = Object.freeze(
  new Map<string, ToolRendererSpec>(),
);
const noInputs: ReadonlyMap<string, string> = Object.freeze(
  new Map<string, string>(),
);

const subscribe = (listener: () => void): (() => void) =>
  chatViewsRegistry()?.subscribe(listener) ?? (() => {});

/** The window's tool renderers by tool name (`chat.views/v1` 1.2.0), live. */
export const useToolRenderers = (): ReadonlyMap<string, ToolRendererSpec> =>
  useSyncExternalStore(
    subscribe,
    () => chatViewsRegistry()?.toolRenderers() ?? noTools,
  );

/** The window's input renderers' element tags by source key (1.2.0), live. */
export const useInputRenderers = (): ReadonlyMap<string, string> =>
  useSyncExternalStore(
    subscribe,
    () => chatViewsRegistry()?.inputRenderers() ?? noInputs,
  );
