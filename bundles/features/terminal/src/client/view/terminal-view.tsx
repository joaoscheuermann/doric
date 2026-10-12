import '@xterm/xterm/css/xterm.css';

import { Button } from 'desktop/ui/button';
import { XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { TerminalApi } from '../api.js';
import {
  type Terminal as TerminalSession,
  unseenOutput,
} from '../domain/terminals.js';
import type { TerminalWatchApi } from '../output-watch.js';
import { messageFrom } from '../store.js';
import { loadXterm } from './xterm.js';

/**
 * One terminal's emulator (moved from the layout's provisional
 * `terminal-view.tsx`, before that the renderer's `organisms/terminal-view`):
 * xterm with its options, fit and resize, the output watch, and the
 * `Terminal <command>` section.
 */
export function TerminalView({
  api,
  watches,
  session,
  onClose,
  showHeader = true,
}: {
  readonly api: TerminalApi;
  readonly watches: TerminalWatchApi;
  readonly session: TerminalSession;
  readonly onClose?: () => void;
  readonly showHeader?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let teardown: (() => void) | undefined;
    void loadXterm().then(({ FitAddon, Terminal }) => {
      if (disposed || !container.current) return;
      const palette = getComputedStyle(
        container.current.closest('[data-slot="terminal-view"]') ??
          container.current,
      );
      const typography = getComputedStyle(container.current);
      const terminal = new Terminal({
        fontFamily: typography.fontFamily,
        fontSize: Number.parseFloat(typography.fontSize),
        fontWeight: Number(typography.fontWeight),
        fontWeightBold: 500,
        cursorBlink: true,
        disableStdin: session.state === 'exited',
        convertEol: !session.pty,
        scrollback: 10000,
        overviewRuler: {
          width: 10,
          showTopBorder: false,
          showBottomBorder: false,
        },
        theme: {
          background: palette.backgroundColor,
          foreground: palette.color,
          overviewRulerBorder: '#00000000',
          scrollbarSliderBackground: palette
            .getPropertyValue('--border')
            .trim(),
          scrollbarSliderHoverBackground: palette
            .getPropertyValue('--border')
            .trim(),
          scrollbarSliderActiveBackground: palette
            .getPropertyValue('--border')
            .trim(),
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container.current);
      let sequence = 0;
      const report = (reason: unknown) => {
        if (!disposed) setError(messageFrom(reason));
      };
      const unwatch = watches.watch(session.id, 0, (update) => {
        if (disposed) return;
        if (update.kind === 'error') {
          setError(update.message);
          return;
        }
        setError(undefined);
        if (update.kind === 'snapshot') {
          terminal.reset();
          if (update.truncated)
            terminal.writeln('[Earlier output is no longer available]');
          terminal.write(update.data);
          sequence = update.sequence;
        } else if (update.sequence > sequence) {
          terminal.write(unseenOutput(update.data, update.sequence, sequence));
          sequence = update.sequence;
        }
      });
      const input = terminal.onData((data) => {
        void api.input(session.id, data).catch(report);
      });
      const resize = () => {
        if (!container.current?.clientWidth || !container.current.clientHeight)
          return;
        fit.fit();
        if (session.state !== 'exited' && session.pty)
          void api
            .resize(session.id, terminal.cols, terminal.rows)
            .catch(report);
      };
      const observer = new ResizeObserver(resize);
      observer.observe(container.current);
      resize();
      terminal.focus();
      teardown = () => {
        observer.disconnect();
        input.dispose();
        unwatch();
        terminal.dispose();
      };
    });
    return () => {
      disposed = true;
      teardown?.();
    };
  }, [api, watches, session.id, session.pty, session.state]);
  return (
    <section
      data-slot="terminal-view"
      aria-label={`Terminal ${session.command}`}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {showHeader && (
        <header className="flex chrome-bar shrink-0 items-center gap-2 border-b bg-sidebar px-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {session.command}
            {session.state === 'exited' ? ' · exited' : ''}
          </span>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Hide terminal"
              onClick={onClose}
            >
              <XIcon />
            </Button>
          )}
        </header>
      )}
      {error && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden pt-1 pl-4">
        <div
          ref={container}
          className="h-full w-full font-conversation text-sm font-light"
        />
      </div>
    </section>
  );
}
