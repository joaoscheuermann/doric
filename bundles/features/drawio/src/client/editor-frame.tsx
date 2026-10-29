// The modal's draw.io editor (spec "O modal do diagrama", Editar): one
// visible iframe and the `DrawioClient` over it. The component owns only the
// iframe and the client's lifecycle; the modal's machine drives the client
// through `onInit` and `onEvent`.

import { buildEditorUrl, type DrawioConfig } from '@drawio/react';
import { DRAWIO_ORIGIN } from 'bundle/contracts';
import { type ReactElement, useEffect, useRef } from 'react';

import {
  type DiagramTheme,
  EDITOR_LOAD_TIMEOUT_MS,
} from '../contracts/index.js';
import type { DiagramDrawing } from './drawing.js';

/**
 * What the modal uses of `@drawio/react`'s `DrawioClient`; a `DrawioClient`
 * satisfies it.
 */
export interface EditorClient {
  /** Loads the diagram; resolves with the `load` event, rejects with a `DrawioError`. */
  load(request: {
    readonly xml: string;
    readonly autosave: true;
  }): Promise<unknown>;
  /** The editor's current XML; rejects with a `DrawioError` (`timeout` after `requestTimeout`). */
  getXml(): Promise<string>;
  /** Stops listening; pending requests reject with `closed`. Idempotent. */
  close(): void;
}

/** Any event of the editor; the modal reads `autosave.xml` and `shortcut.command`. */
export interface EditorEvent {
  readonly event: string;
}

/** What `EditorFrame` passes to `DiagramDrawing.createEditorClient`. */
export interface EditorClientOptions {
  /** `editorUrl(theme)`. */
  readonly url: string;
  /** EDITOR_CONFIG. */
  readonly config: DrawioConfig;
  /** Called at every `init`, also after a restart; must call `load`. */
  readonly onInit: (client: EditorClient) => void;
  /** Called with every event of the editor. */
  readonly onEvent: (event: EditorEvent) => void;
  /** EDITOR_LOAD_TIMEOUT_MS. */
  readonly requestTimeout: number;
}

/**
 * The editor's configuration:
 * `{ suppressNewWindows: true, compressXml: false, passThroughKeys: [{ key: 's', ctrl: true, command: 'save' }] }`.
 */
export const EDITOR_CONFIG: DrawioConfig = {
  suppressNewWindows: true,
  compressXml: false,
  passThroughKeys: [{ key: 's', ctrl: true, command: 'save' }],
};

/**
 * The editor URL for `theme`:
 * `buildEditorUrl(`${DRAWIO_ORIGIN}/index.html`, { stealth, lockdown, pwa: false,
 * noSaveBtn, noExitBtn, saveAndExit: false, ui: 'min', dark: theme === 'dark',
 * lang: 'pt-br' }, true)`, which is, for light:
 * `https://drawio.doric.invalid/index.html?spin=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&ui=min&dark=0&lang=pt-br&embed=1&proto=json&configure=1`
 * (`dark=1` exactly for `'dark'`). Pure; never throws.
 */
export const editorUrl: (theme: DiagramTheme) => string = (theme) =>
  buildEditorUrl(
    `${DRAWIO_ORIGIN}/index.html`,
    {
      stealth: true,
      lockdown: true,
      pwa: false,
      noSaveBtn: true,
      noExitBtn: true,
      saveAndExit: false,
      ui: 'min',
      dark: theme === 'dark',
      lang: 'pt-br',
    },
    true,
  );

export interface EditorFrameProps {
  readonly drawing: Pick<DiagramDrawing, 'createEditorClient'>;
  /** Read once, at mount: the editor keeps the theme it opened with. */
  readonly theme: DiagramTheme;
  readonly onInit: (client: EditorClient) => void;
  readonly onEvent: (event: EditorEvent) => void;
}

/**
 * One `<iframe data-testid="drawio-editor-frame" title="Editor de diagrama"
 * sandbox="allow-scripts allow-same-origin">` filling its parent, and one client
 * over it, created at mount with `{ url: editorUrl(theme), config: EDITOR_CONFIG,
 * onInit, onEvent, requestTimeout: EDITOR_LOAD_TIMEOUT_MS }` (callbacks through
 * refs, so the latest props answer). Never sets `src`. Unmount closes the client.
 */
export function EditorFrame({
  drawing,
  theme,
  onInit,
  onEvent,
}: EditorFrameProps): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const drawingRef = useRef(drawing);
  const themeRef = useRef(theme);
  const onInitRef = useRef(onInit);
  const onEventRef = useRef(onEvent);

  onInitRef.current = onInit;
  onEventRef.current = onEvent;

  useEffect(() => {
    const iframe = iframeRef.current;

    if (iframe === null) return;

    const client = drawingRef.current.createEditorClient(iframe, {
      url: editorUrl(themeRef.current),
      config: EDITOR_CONFIG,
      onInit: (editor) => onInitRef.current(editor),
      onEvent: (event) => onEventRef.current(event),
      requestTimeout: EDITOR_LOAD_TIMEOUT_MS,
    });

    return () => client.close();
  }, []);

  return (
    <iframe
      ref={iframeRef}
      data-testid="drawio-editor-frame"
      title="Editor de diagrama"
      sandbox="allow-scripts allow-same-origin"
      className="size-full border-0"
    />
  );
}
