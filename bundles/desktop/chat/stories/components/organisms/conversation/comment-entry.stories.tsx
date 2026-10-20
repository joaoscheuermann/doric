// The inline comment entry a selection inside one of the agent's messages
// opens: the seat `CommentSeatNode` puts right after the paragraph the
// selection starts in, and the two states `CommentEntry` draws there — a lone
// placeholder field, then the comment line the first typed character
// materialises. Both states stand on the same answer, so the page reads as one
// gesture in two moments; the last section is the colour the transcript paints
// the selection itself in, shown as a specimen so it can be judged without
// dragging.
//
// The waiting entry is opened the way a selection opens it (`openSeat` on the
// answer's turn, after the block that holds the words) and the paragraph keeps
// a real selection (`TextNode.select`, as `plugins/comment-selection.stories`
// does). The written entry is the same seat typed into through its own editing
// host: the story sets the note's text and fires the `input` event a keystroke
// fires (`StackNote` reports what its host holds on that event), which is the
// path `CommentEntry` takes its text state from. The stack item the first
// character also adds is answered by the story window's fake composer, so the
// draft lands the way it does in the window instead of failing.

import { Marker, MarkerContent } from 'desktop/ui/marker';
import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalNode,
} from 'lexical';
import { type RefObject, useEffect, useRef } from 'react';

import { $isAgentTurnNode } from '../../../../src/client/components/organisms/conversation/nodes/agent-turn-node.js';
import {
  answer,
  promptIdOf,
  turnsOfLog,
} from '../../../support/conversation.js';
import {
  $appendTurns,
  $createSectionCaptionNode,
  ConversationEditor,
} from '../../../support/editor.js';

const waitingPrompt = promptIdOf(4701);
const writtenPrompt = promptIdOf(4702);

/**
 * The answer both sections show: a heading, the paragraph the reader selects
 * in, and the one below it — so the entry stands between two paragraphs, as it
 * does in the transcript.
 */
const answerText = [
  '## Checkout card',
  '',
  'The card now follows the new layout: the summary sits above the payment form, and the Pay button uses the primary token.',
  '',
  'Dark mode broke because the old stylesheet set its own background; that file is gone now.',
].join('\n');

/** The words the reader selected, and the entry quotes. */
const quote = 'the summary sits above the payment form';

/** The note the written section's entry holds, typed in a character after it opened. */
const note = 'Name the form component here, so the layout is easy to find.';

const waitingTurns = turnsOfLog((log) => {
  log.prompt(waitingPrompt, 'Review the checkout card.');
  answer(log, waitingPrompt, answerText);
});

const writtenTurns = turnsOfLog((log) => {
  log.prompt(writtenPrompt, 'Review the checkout card.');
  answer(log, writtenPrompt, answerText);
});

/** The first text of a block, where a selection can start. */
const firstText = (node: LexicalNode | undefined) => {
  let current: LexicalNode | null | undefined = node;
  while ($isElementNode(current)) current = current.getFirstChild();
  return $isTextNode(current) ? current : undefined;
};

/** Selects the quoted words inside a block, as a drag over them does. */
const $selectQuote = (block: LexicalNode | undefined, words: string): void => {
  const text = firstText(block);
  if (text === undefined) return;
  const start = text.getTextContent().indexOf(words);
  if (start < 0) return;
  text.select(start, start + words.length);
};

/**
 * The note host the written section shows, as a box: the seed fills its id once
 * the seat is opened (`<turn>:<block>`, the id `StackNote` carries), and the
 * typing plugin below reads it a frame later, when the entry is in the DOM.
 */
interface WrittenEntry {
  id: string;
}

/**
 * Types the note into the entry the seed opened for the written section: the
 * note's own editing host reports what it holds on `input`, the event a typed
 * character fires, so the entry reaches its written state by the product's own
 * path. The host is asked for again every frame until the seat has drawn — the
 * editor builds its state before its decorators reach the document.
 */
function TypeIntoEntry({
  target,
  text,
}: {
  readonly target: RefObject<WrittenEntry>;
  readonly text: string;
}) {
  useEffect(() => {
    let done = false;
    let frame = 0;
    let tries = 0;

    const write = (): void => {
      if (done) return;
      const host = document.querySelector<HTMLElement>(
        `[data-stack-note="${target.current.id}"]`,
      );
      if (host === null) {
        // Bounded: a seat that never draws must not keep the story spinning.
        if (tries >= 240) return;
        tries += 1;
        frame = requestAnimationFrame(write);
        return;
      }
      done = true;
      host.textContent = text;
      host.dispatchEvent(new InputEvent('input', { bubbles: true }));
    };

    frame = requestAnimationFrame(write);
    return () => {
      done = true;
      cancelAnimationFrame(frame);
    };
  }, [target, text]);

  return null;
}

/**
 * The transcript's selection rule, as the chat's own sheet states it
 * (`src/client/styles.css`, `[data-lexical-editor] ::selection`): the primary
 * ink for the words and their underline, over a mix of it for the ground.
 */
const SELECTION_STYLE = {
  color: 'var(--primary)',
  background: 'color-mix(in oklch, var(--primary) 18%, transparent)',
  textDecoration: 'underline',
  textDecorationColor: 'var(--primary)',
} as const;

/** Those declarations as the sheet writes them, so the specimen states the rule. */
const SELECTION_RULE = [
  '[data-lexical-editor] ::selection {',
  '  color: var(--primary);',
  '  background: color-mix(in oklch, var(--primary) 18%, transparent);',
  '  text-decoration: underline;',
  '  text-decoration-color: var(--primary);',
  '}',
].join('\n');

/**
 * The colours, as a specimen: a sentence of an answer with the quoted words
 * painted in the rule above — the visual of a selection, without a drag. It is
 * framed as a specimen and not as a block of the transcript, which is what the
 * caption and the rule it prints say.
 */
function SelectionSpecimen() {
  return (
    <figure className="mt-4 flex flex-col gap-2 rounded-md border border-border border-dashed p-4">
      <Marker variant="separator" className="gap-1.5 text-xs">
        <MarkerContent className="uppercase tracking-wide">
          The colours the selection wears
        </MarkerContent>
      </Marker>
      <p className="font-conversation text-sm font-light leading-normal">
        The card now follows the new layout:{' '}
        <span style={SELECTION_STYLE}>{quote}</span>, and the Pay button uses
        the primary token.
      </p>
      <pre className="overflow-x-auto rounded-sm bg-muted/50 p-2 text-xs text-muted-foreground">
        <code>{SELECTION_RULE}</code>
      </pre>
      <figcaption className="text-xs text-muted-foreground">
        A specimen, not the transcript: the transcript paints the words the
        reader selects while dragging, which a still page cannot hold. The
        declarations above are the ones it applies, painted here on a sentence
        of the answer above.
      </figcaption>
    </figure>
  );
}

/**
 * One page, three sections: the entry waiting after the paragraph the
 * selection starts in, the same entry written, and the colour the transcript
 * gives a selection.
 */
function CommentEntryPage() {
  // Filled by the seed when it opens the written seat; the box is stable, so
  // the typing plugin reads the id the seed wrote however late it arrives.
  const written = useRef<WrittenEntry>({ id: '' });

  return (
    <ConversationEditor
      seed={() => {
        $getRoot().append(
          $createSectionCaptionNode(
            'The entry, waiting — a selection in the paragraph opened it, nothing is written yet',
          ),
        );
        const waiting = $appendTurns(waitingTurns).at(-1);
        if ($isAgentTurnNode(waiting)) {
          waiting.openSeat(1, quote);
          $selectQuote(waiting.getChildren()[1], quote);
        }

        $getRoot().append(
          $createSectionCaptionNode(
            'The entry, written — the first character draws the comment line',
          ),
        );
        const answered = $appendTurns(writtenTurns).at(-1);
        if (!$isAgentTurnNode(answered)) return;
        const seat = answered.openSeat(1, quote);
        written.current.id = `${seat.turn}:${seat.block}`;
      }}
    >
      <TypeIntoEntry target={written} text={note} />
      <SelectionSpecimen />
    </ConversationEditor>
  );
}

export default {
  title: 'Chat/Organisms/Conversation comment entry',
  parameters: { layout: 'padded' },
};

/**
 * The entry in both of its states, and the selection colour between them: a
 * selection inside the agent's answer opens a lone field after the paragraph,
 * whose first typed character turns into the comment line quoting it.
 */
export const States = { render: () => <CommentEntryPage /> };
