// The window's single keydown listener (section 15.7, decision 78): the table
// comes from `doric.shell/v1.keybindings`, already filtered for this window;
// a match asks main to dispatch it. Edit roles are native accelerators and
// never appear in the table.

import type { Disposable } from 'bundle/contracts';

import { shellNotify, shellStream } from './bridge.js';
import type { DoricDesktopApi, ShellKeybinding } from './protocol.js';

interface Chord {
  readonly key: string;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

const keyAliases: Readonly<Record<string, string>> = {
  esc: 'escape',
  escape: 'escape',
  return: 'enter',
  enter: 'enter',
  space: ' ',
  plus: '+',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
};

/**
 * Parses an accelerator (`CmdOrCtrl+Shift+P`) into a chord; `CmdOrCtrl`
 * is Meta on macOS and Control elsewhere. Undefined when malformed.
 */
export const parseAccelerator = (
  accelerator: string,
  mac: boolean,
): Chord | undefined => {
  const parts = accelerator.split(/\+(?!$)/).map((part) => part.trim());
  const key = parts.pop();

  if (key === undefined || key === '') {
    return undefined;
  }

  const chord = { meta: false, ctrl: false, alt: false, shift: false };

  for (const modifier of parts.map((part) => part.toLowerCase())) {
    switch (modifier) {
      case 'cmd':
      case 'command':
      case 'meta':
      case 'super':
        chord.meta = true;
        break;
      case 'ctrl':
      case 'control':
        chord.ctrl = true;
        break;
      case 'cmdorctrl':
      case 'commandorcontrol':
        if (mac) {
          chord.meta = true;
        } else {
          chord.ctrl = true;
        }
        break;
      case 'alt':
      case 'option':
        chord.alt = true;
        break;
      case 'shift':
        chord.shift = true;
        break;
      default:
        return undefined;
    }
  }

  const lower = key.toLowerCase();

  return { key: keyAliases[lower] ?? lower, ...chord };
};

/** Whether a keydown event is the chord. */
export const matchesChord = (event: KeyboardEvent, chord: Chord): boolean =>
  event.key.toLowerCase() === chord.key &&
  event.metaKey === chord.meta &&
  event.ctrlKey === chord.ctrl &&
  event.altKey === chord.alt &&
  event.shiftKey === chord.shift;

const isMac = (): boolean => {
  const platform = (globalThis as { navigator?: { platform?: string } })
    .navigator?.platform;

  return typeof platform === 'string' && /^mac/i.test(platform);
};

/**
 * Installs the capture-phase keydown listener and follows the window's
 * table. With an empty table (stage 8 production) no key is intercepted.
 */
export const installKeybindings = (input: {
  readonly desktop: DoricDesktopApi;
  readonly target?: Pick<
    EventTarget,
    'addEventListener' | 'removeEventListener'
  >;
  readonly mac?: boolean;
}): Disposable => {
  const { desktop } = input;
  const target = input.target ?? globalThis;
  const mac = input.mac ?? isMac();
  let table: readonly { readonly key: string; readonly chord: Chord }[] = [];
  const stream = shellStream<readonly ShellKeybinding[]>(
    desktop,
    'keybindings',
    (bindings) => {
      table = bindings.flatMap(({ key }) => {
        const chord = parseAccelerator(key, mac);

        return chord === undefined ? [] : [{ key, chord }];
      });
    },
  );
  const onKeyDown = (event: Event) => {
    const keyboard = event as KeyboardEvent;
    const match = table.find(({ chord }) => matchesChord(keyboard, chord));

    if (match === undefined) {
      return;
    }

    keyboard.preventDefault();
    shellNotify(desktop, 'keybinding', { key: match.key });
  };

  target.addEventListener('keydown', onKeyDown, { capture: true });

  return {
    dispose: () => {
      target.removeEventListener('keydown', onKeyDown, { capture: true });
      stream.dispose();
    },
  };
};
