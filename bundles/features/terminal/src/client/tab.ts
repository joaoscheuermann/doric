// The workspace tab of a terminal (`layout.tabs/v1`): its id, title, element
// and, from layout.tabs/v1 1.2.0, its context menu (A7, §4.4).

import { type Terminal, terminalTitle } from './domain/terminals.js';
import type { TabRequest } from './peers.js';

/** The element a terminal's workspace tab shows. */
export const TERMINAL_VIEW_TAG = 'terminal-view';

/** The id of a terminal's workspace tab. */
export const terminalTabId = (terminalId: string): string =>
  `terminal:${terminalId}`;

/**
 * What `layout.tabs/v1.open` receives for a terminal: titled by its name, else
 * its command; the menu holds Kill terminal (A7), which runs `kill`.
 */
export const terminalTab = (
  terminal: Terminal,
  kill: (terminalId: string) => void,
): TabRequest => ({
  id: terminalTabId(terminal.id),
  title: terminalTitle(terminal),
  tag: TERMINAL_VIEW_TAG,
  props: { terminalId: terminal.id, showHeader: terminal.origin !== 'user' },
  icon: 'terminal',
  menu: [
    {
      id: 'kill',
      label: 'Kill terminal',
      destructive: true,
      run: () => kill(terminal.id),
    },
  ],
});
