import * as React from 'react';

const PortalContainerContext = React.createContext<HTMLElement | undefined>(
  undefined,
);

export interface PortalContainerProviderProps {
  /**
   * Where the overlays below portal their content. `null` or `undefined`
   * keeps each overlay's own default, the document body.
   */
  readonly container: HTMLElement | null | undefined;
  readonly children?: React.ReactNode;
}

/**
 * Sends the portaled content of every `desktop/ui` overlay below it (Dialog,
 * Sheet, AlertDialog, Popover, Tooltip, Select, DropdownMenu, ContextMenu,
 * Combobox and the components built on them) into `container` instead of the
 * document body: a React root mounted inside a shadow root keeps its overlays
 * there, under its own styles. A `container` passed to an overlay's portal
 * directly still wins.
 */
export function PortalContainerProvider({
  container,
  children,
}: PortalContainerProviderProps): React.JSX.Element {
  return (
    <PortalContainerContext.Provider value={container ?? undefined}>
      {children}
    </PortalContainerContext.Provider>
  );
}

/**
 * The container the nearest `PortalContainerProvider` names, or `undefined`
 * (the document body) outside one.
 */
export function usePortalContainer(): HTMLElement | undefined {
  return React.useContext(PortalContainerContext);
}
