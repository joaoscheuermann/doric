// `<threads-delegated-turn>`: another Thread's input in this conversation (a
// delegated instruction or result), drawn as the renderer's
// `DelegatedTurnNode` drew it. Chat hosts it for `chat.delegated-input/v1`
// (R-9.7): it sets `block` and `focused`, calls `toggle()` and reads
// `chosen`. The text is chat's read-only Markdown (`<chat-readonly-markdown>`,
// R-9.9).

import { type Services, UiV1 } from 'bundle/contracts';
import { Button } from 'desktop-ui/button';
import { defineReactElement } from 'desktop-ui/react-element';
import { TooltipProvider } from 'desktop-ui/tooltip';
import { cn } from 'desktop-ui/utils';
import { BotIcon } from 'lucide-react';
import { type ReactNode, StrictMode, useEffect, useRef } from 'react';

import { blockInput, type ChatBlockElement } from './chat-contract.js';
import { CollapsibleBlock } from './collapsible-block.js';
import type { DelegatedInput } from './domain/delegated.js';
import { useDelegatedSource } from './source.js';

export const DELEGATED_TURN_TAG = 'threads-delegated-turn';

/** Chat's read-only Markdown element, in the conversation's theme. */
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

  return <div ref={frame} style={{ display: 'contents' }} />;
}

export function DelegatedTurn({
  input,
  open,
  focused,
  onOpenChange,
  services,
}: {
  readonly input: DelegatedInput;
  readonly open: boolean;
  readonly focused: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly services: Services;
}) {
  const source = useDelegatedSource(input.threadId, services);
  return (
    <CollapsibleBlock
      label={
        <>
          <BotIcon className="size-4.5 shrink-0" aria-hidden="true" />
          <span>
            {input.kind === 'parent' ? 'Instruction from:' : 'Result from:'}
          </span>
        </>
      }
      action={{
        toggleLabel: `Toggle ${input.kind === 'parent' ? 'instruction' : 'result'} from ${source.label.value}`,
        content: (
          <span
            role="none"
            className="inline-flex min-w-0 items-center"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <span className="shrink-0">&quot;</span>
            {source.open === undefined ? (
              <span
                className={cn('truncate', source.label.mono && 'font-mono')}
                title={input.threadId}
              >
                {source.label.value}
              </span>
            ) : (
              <Button
                variant="link"
                size="sm"
                className="h-auto min-w-0 shrink px-0 py-0"
                title={input.threadId}
                onClick={source.open}
              >
                <span className="truncate">{source.label.value}</span>
              </Button>
            )}
            <span className="shrink-0">&quot;</span>
          </span>
        ),
      }}
      open={open}
      focused={focused}
      onOpenChange={onOpenChange}
    >
      {input.status === undefined ? null : (
        <div className="mb-2">Status: {input.status}</div>
      )}
      <ReadonlyMarkdown text={input.text} services={services} />
    </CollapsibleBlock>
  );
}

interface ElementProps {
  readonly block?: unknown;
  readonly focused?: boolean;
  readonly chosenState?: boolean;
  readonly onChosenChange?: (chosen: boolean) => void;
}

function Root({ children }: { readonly children?: ReactNode }) {
  return (
    <StrictMode>
      <TooltipProvider>{children}</TooltipProvider>
    </StrictMode>
  );
}

/**
 * The element class, made inside activation [D10-7]. The reader's open state
 * is the element's own: a delegated instruction starts open and a result
 * starts closed, and the reader's choice then stands.
 */
export const defineDelegatedTurnElement = () => {
  const Base = defineReactElement<ElementProps>({
    props: ['block', 'focused', 'chosenState', 'onChosenChange'],
    render: ({ block, focused, chosenState, onChosenChange, services }) => {
      const input = blockInput(block);
      if (input === undefined) return null;
      return (
        <DelegatedTurn
          input={input}
          open={chosenState ?? input.kind === 'parent'}
          focused={focused === true}
          onOpenChange={(next) => onChosenChange?.(next)}
          services={services}
        />
      );
    },
    wrap: () => Root,
  });

  return class DelegatedTurnElement
    extends Base
    implements ChatBlockElement, ElementProps
  {
    declare block: unknown;
    declare focused: boolean;
    declare chosenState: boolean | undefined;
    declare onChosenChange: (chosen: boolean) => void;

    constructor() {
      super();
      this.onChosenChange = (chosen) => {
        this.chosenState = chosen;
      };
    }

    get chosen(): boolean {
      return this.chosenState ?? blockInput(this.block)?.kind === 'parent';
    }

    toggle(): void {
      this.chosenState = !this.chosen;
    }
  };
};
