// The platform window API as this bundle uses it, narrowed to the three calls
// a view needs. `doric.windows/v1.open` already focuses an open key and loads
// the new path when the screen moved, so the desktop part asks for a window it
// wants visible; `navigate` is the explicit re-point the heal loop uses.

import type { WindowAction } from './status.js';

/**
 * The request one view's window is opened with: a host-relative path, its own
 * session partition and the view's label as the native window title. No preload
 * and no app chrome — the window hosts the host's page alone.
 */
export interface OpenScreenWindow {
  readonly key: string;
  readonly view: {
    readonly path: string;
    readonly partition: string;
    readonly title: string;
  };
  readonly appearance: { readonly titleBar: 'native' };
}

/**
 * The slice of `doric.windows/v1` this bundle reaches. `focus` answers whether
 * a window with that key was open, which is how a stale key is noticed.
 */
export interface ScreenWindows {
  open(request: OpenScreenWindow): Promise<void>;
  focus(key: string): Promise<boolean>;
  navigate(input: {
    readonly key: string;
    readonly path: string;
  }): Promise<void>;
}

/** The window key and partition of one view; both carry its own id. */
export const windowKeyOf = (viewId: string): string => `screen:${viewId}`;

/** The request that opens one view's window at `path`. */
export const openRequestOf = (input: {
  readonly viewId: string;
  readonly label: string;
  readonly path: string;
}): OpenScreenWindow => ({
  key: windowKeyOf(input.viewId),
  view: {
    path: input.path,
    partition: windowKeyOf(input.viewId),
    title: input.label,
  },
  appearance: { titleBar: 'native' },
});

/** What applying one window action did, for the desktop part's own state. */
export type WindowOutcome =
  | 'opened'
  | 'navigated'
  | 'focused'
  | 'absent'
  | 'ignored';

/**
 * Carries out one window decision. `focus` that finds no window answers
 * `absent`: the key was stale, so the caller opens the window again.
 */
export const applyWindowAction = async (input: {
  readonly windows: ScreenWindows;
  readonly action: WindowAction;
  readonly request: OpenScreenWindow;
}): Promise<WindowOutcome> => {
  const { windows, action, request } = input;

  switch (action.kind) {
    case 'none':
      return 'ignored';
    case 'open':
      await windows.open({
        ...request,
        view: { ...request.view, path: action.path },
      });

      return 'opened';
    case 'navigate':
      await windows.navigate({ key: request.key, path: action.path });

      return 'navigated';
    case 'focus':
      return (await windows.focus(request.key)) ? 'focused' : 'absent';
  }
};
