// The `default-skill-call` element (bundle isolation 5(b), change 2): the
// block a `load_skill` call draws in the transcript, moved from the chat's
// `components/molecules/skill-tool-item.tsx` and registered through
// `chat.views/v1`. The chat creates one element per call and sets its `view`;
// the element draws the block from it and reports the reader's open/close
// choice with `chat-block-chosen`.

import type { ChatToolView } from 'chat/contracts';
import type { ErrorCatalog, ErrorInfo } from 'desktop/reads';
import {
  blockOpen,
  type Chosen,
  CollapsibleBlock,
} from 'desktop/ui/collapsible-block';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { defineReactElement } from 'desktop/ui/react-element';
import { memo, useCallback, useMemo, useRef } from 'react';

import {
  LOAD_SKILL_TOOL,
  parseSkillLoad,
  skillOpenness,
  skillSourceLabel,
  type ToolStatus,
} from './skill-load.js';

/** The tag `default` defines through `ui/v1` and registers for `load_skill`. */
export const SKILL_CALL_TAG = 'default-skill-call';

/**
 * The one event a tool element dispatches when the reader opens or closes its
 * block (`chat.views/v1` 1.2.0's `CHAT_BLOCK_CHOSEN_EVENT`), written here as a
 * literal: `default` imports only the chat's types.
 */
const CHAT_BLOCK_CHOSEN_EVENT = 'chat-block-chosen';

/**
 * The codes the skill block's failure notice names beside the shared entries:
 * `tool_failed`, its fallback (OD-6).
 */
export const defaultToolCatalog: ErrorCatalog = {
  tool_failed: { title: 'Tool failed', retryable: false },
};

type SkillToolItemProps = {
  readonly args: string;
  readonly error?: ErrorInfo;
  readonly result?: string;
  readonly status: ToolStatus;
  /** The reader's choice of open/closed, held by the block's owner. */
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  /** Whether the block is the caret's stop. */
  readonly focused?: boolean;
};

const VERBS: Readonly<Record<ToolStatus, string>> = {
  running: 'Loading skill',
  finished: 'Loaded skill',
  failed: 'Failed to load skill',
};

/**
 * A `load_skill` call as its own block. Header: verb by status ("Loading
 * skill" / "Loaded skill" / "Failed to load skill"), the name (font-mono), the
 * muted `skillSourceLabel`. Body: the result as plain pre-wrap text, or the
 * error's compact notice. Openness `skillOpenness(status)` via
 * CollapsibleBlock.
 */
export const SkillToolItem = memo(function SkillToolItem({
  args,
  chosen,
  error,
  focused,
  onChosenChange,
  result,
  status,
}: SkillToolItemProps) {
  const { name, source } = useMemo(() => parseSkillLoad(args), [args]);

  return (
    <CollapsibleBlock
      chosen={chosen}
      focused={focused}
      label={
        <>
          <span className="font-normal">{VERBS[status]}</span>{' '}
          <span data-slot="skill-name" className="font-mono font-light">
            {name}
          </span>{' '}
          <span
            data-slot="skill-source"
            className="font-light text-muted-foreground/70"
          >
            · {skillSourceLabel(source)}
          </span>
        </>
      }
      onChosenChange={onChosenChange}
      openness={skillOpenness(status)}
    >
      {error !== undefined ? (
        <ErrorNotice
          variant="compact"
          error={error}
          catalog={defaultToolCatalog}
          fallbackCode="tool_failed"
          context={{ Tool: LOAD_SKILL_TOOL }}
        />
      ) : result !== undefined ? (
        <div className="whitespace-pre-wrap break-words">{result}</div>
      ) : null}
    </CollapsibleBlock>
  );
});

/** Dispatches the reader's choice from `target`; it bubbles to the element. */
const dispatchChosen = (target: EventTarget, chosen: boolean): void => {
  target.dispatchEvent(
    new CustomEvent<{ readonly chosen: boolean }>(CHAT_BLOCK_CHOSEN_EVENT, {
      detail: { chosen },
      bubbles: true,
      composed: true,
    }),
  );
};

/** What the chat sets on the element. */
interface SkillCallProps {
  readonly view?: ChatToolView;
}

/**
 * Draws the block of the element's `view` and reports the reader's choice
 * from its root, whose parent is the element: the event bubbles to the
 * element, where the chat keeps it.
 */
function SkillCall({ view }: SkillCallProps) {
  const root = useRef<HTMLDivElement>(null);
  const onChosenChange = useCallback((chosen: boolean) => {
    if (root.current !== null) dispatchChosen(root.current, chosen);
  }, []);
  if (view === undefined) return null;
  return (
    <div ref={root} className="contents">
      <SkillToolItem
        args={view.args}
        {...(view.result === undefined ? {} : { result: view.result })}
        {...(view.error === undefined ? {} : { error: view.error })}
        status={view.status}
        chosen={view.chosen}
        focused={view.focused}
        onChosenChange={onChosenChange}
      />
    </div>
  );
}

/**
 * The `default-skill-call` element class: maps `view` (`ChatToolView`) to the
 * block and dispatches `chat-block-chosen` for the reader's choice. Its
 * `toggle()` (O2) reports the opposite of what the block shows by the skill's
 * own rule (open when the load failed), which differs from the chat's generic
 * answer.
 */
export const defineSkillCallElement = () => {
  const Base = defineReactElement<SkillCallProps>({
    props: ['view'],
    render: SkillCall,
  });
  return class SkillCallElement extends Base {
    declare view: ChatToolView | undefined;

    toggle(): void {
      const view = this.view;
      if (view === undefined) return;
      dispatchChosen(this, !blockOpen(view.chosen, skillOpenness(view.status)));
    }
  };
};
