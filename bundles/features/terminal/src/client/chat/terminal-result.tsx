// The `terminal-result` element (bundle isolation 5(b), change 4): a
// background terminal's answer, the prompt the host enqueues when the command
// settles, drawn as its own block in the chat's transcript, moved from the
// chat's `components/organisms/conversation/nodes/terminal-result-node.tsx`
// and registered through `chat.views/v1` as the input renderer of the source
// `terminal`. The chat creates one element per prompt and sets its `view`.
//
// The block is the card a `terminal` call draws (`TerminalBlock`), named by
// the verbs a settled background command owns instead of `Ran`/`Failed`. It
// is folded away behind the command it answered, and open when the command
// did not finish cleanly (`terminalResultOpenness`). A terminal prompt the host
// did not frame (T-4) is the text it is: the chat's read-only Markdown,
// created through `ui/v1`, folded once settled by the chat's generic rule.

import { type Services, UiV1 } from 'bundle/contracts';
import {
  blockOpen,
  CollapsibleBlock,
  type Openness,
} from 'desktop/ui/collapsible-block';
import { defineReactElement } from 'desktop/ui/react-element';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  parseTerminalResult,
  type TerminalResult,
  terminalResultFailed,
} from '../domain/terminal-result.js';
import { wholeStream } from '../domain/terminal-tool.js';
import type { TerminalClient } from '../elements.js';
import type { ChatInputView } from '../peers.js';
import {
  dispatchChosen,
  TerminalBlock,
  type TerminalVerbs,
} from './terminal-call.js';

/** The tag `terminal` defines through `ui/v1` and registers for the source `terminal`. */
export const TERMINAL_RESULT_TAG = 'terminal-result';

/** The input source whose prompts the block draws. */
export const TERMINAL_SOURCE = 'terminal';

/**
 * A background terminal's answer: open when the command did not finish
 * cleanly — the one result a reader must not scroll past — and folded away
 * when it did, since its output is what the reader asked for earlier and the
 * header already names the command.
 */
export const terminalResultOpenness = (failed: boolean): Openness => ({
  active: false,
  hasContent: true,
  defaultOpen: failed,
});

/**
 * The chat's generic answer for an input block (`settledOpenness`): folded
 * once settled, which a prompt always is.
 */
const settledOpenness: Openness = { active: false, hasContent: true };

/** The verbs a settled background command's block names itself by. */
const BACKGROUND_TERMINAL_VERBS: TerminalVerbs = {
  running: 'Background terminal',
  ran: 'Background terminal',
  failed: 'Background terminal failed',
};

/** What the block shows while the reader has not chosen. */
const openness = (result: TerminalResult | undefined): Openness =>
  result === undefined
    ? settledOpenness
    : terminalResultOpenness(terminalResultFailed(result));

/** The chat's read-only Markdown of `text`, created through `ui/v1`. */
function ReadonlyMarkdown({
  text,
  services,
}: {
  readonly text: string;
  readonly services: Services;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const element = useRef<{ text?: string } | null>(null);

  // The element is created once; later texts are set on it below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const host = frame.current;
    if (host === null) return;
    const ui = services.use(UiV1);
    let created: object;
    try {
      created = ui.create('chat-readonly-markdown', { text });
    } catch (error) {
      console.error(
        'Doric: <chat-readonly-markdown> could not be created:',
        error,
      );
      return;
    }
    element.current = created as { text?: string };
    host.replaceChildren(created as Node);
    return () => {
      element.current = null;
      host.replaceChildren();
      // After this commit: the element's own React root must not unmount
      // while this one is still rendering.
      queueMicrotask(() => {
        try {
          ui.dispose(created);
        } catch {
          // An element already disposed needs nothing more.
        }
      });
    };
  }, [services]);

  useEffect(() => {
    if (element.current !== null) element.current.text = text;
  }, [text]);

  return <div ref={frame} />;
}

/** What the chat sets on the element. */
interface TerminalResultProps {
  readonly view?: ChatInputView;
}

/**
 * Draws the block of the element's `view` and reports the reader's choice
 * from its root, whose parent is the element: the event bubbles to the
 * element, where the chat keeps it.
 */
function TerminalResultBlock({
  view,
  services,
}: TerminalResultProps & { readonly services: Services }) {
  const root = useRef<HTMLDivElement>(null);
  const onChosenChange = useCallback((chosen: boolean) => {
    if (root.current !== null) dispatchChosen(root.current, chosen);
  }, []);
  const text = view?.text;
  const result = useMemo(
    () => (text === undefined ? undefined : parseTerminalResult(text)),
    [text],
  );
  if (view === undefined) return null;
  return (
    <div
      ref={root}
      data-slot="terminal-result"
      data-terminal-id={result?.terminalId}
    >
      {result === undefined ? (
        <CollapsibleBlock
          chosen={view.chosen}
          focused={view.focused}
          label="Terminal"
          onChosenChange={onChosenChange}
          openness={settledOpenness}
        >
          <ReadonlyMarkdown text={view.text} services={services} />
        </CollapsibleBlock>
      ) : (
        <TerminalBlock
          verbs={BACKGROUND_TERMINAL_VERBS}
          chosen={view.chosen}
          command={result.command}
          failed={terminalResultFailed(result)}
          focused={view.focused}
          onChosenChange={onChosenChange}
          openness={openness(result)}
          running={false}
          slot="terminal-result"
          stderr={wholeStream(result.stderr)}
          stdout={wholeStream(result.stdout)}
          toggleLabel={`Toggle background terminal: ${result.command}`}
        />
      )}
    </div>
  );
}

/**
 * The element class: maps `view` (`ChatInputView`) to the block and
 * dispatches `chat-block-chosen` for the reader's choice. Its `toggle()` (O2)
 * reports the opposite of what the block shows: by the result's rule (open
 * when the command failed), or the generic one for a prompt the host did not
 * frame. `client` is the terminal client the row's element shares; the block
 * reads only its `view`.
 */
export const defineTerminalResultElement = (_client: TerminalClient) => {
  const Base = defineReactElement<TerminalResultProps>({
    props: ['view'],
    render: TerminalResultBlock,
  });
  return class TerminalResultElement extends Base {
    declare view: ChatInputView | undefined;

    toggle(): void {
      const view = this.view;
      if (view === undefined) return;
      dispatchChosen(
        this,
        !blockOpen(view.chosen, openness(parseTerminalResult(view.text))),
      );
    }
  };
};
