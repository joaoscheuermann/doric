// The `files-edit-call` element (bundle isolation 5(b), change 1): the block
// an `edit` or `write` call draws in the transcript, moved from the chat's
// `components/molecules/edit-tool-item.tsx` and registered through
// `chat.views/v1`. The chat creates one element per call and sets its `view`;
// the element draws the row from it and reports the reader's open/close choice
// with `chat-block-chosen`.

import type { ChatToolView } from 'chat/contracts';
import { type ErrorCatalog, type ErrorInfo, errorInfo } from 'desktop/reads';
import {
  blockOpen,
  type Chosen,
  CollapsibleBlock,
  type Openness,
} from 'desktop/ui/collapsible-block';
import { ErrorNotice } from 'desktop/ui/error-notice';
import { defineReactElement } from 'desktop/ui/react-element';
import { cn } from 'desktop/ui/utils';
import { memo, useCallback, useMemo, useRef, useState } from 'react';

import { type DiffLine, parseEditCall } from './edit-tool.js';

/** The tag `files` defines through `ui/v1` and registers for `edit` and `write`. */
export const EDIT_CALL_TAG = 'files-edit-call';

/**
 * The one event a tool element dispatches when the reader opens or closes its
 * block (`chat.views/v1` 1.2.0's `CHAT_BLOCK_CHOSEN_EVENT`), written here as a
 * literal: `files` imports only the chat's types.
 */
const CHAT_BLOCK_CHOSEN_EVENT = 'chat-block-chosen';

export const INITIAL_DIFF_LINES = 16;

/** A tool call's status, as the chat's `view` carries it. */
type ToolStatus = ChatToolView['status'];

/**
 * The codes the edit block's failure notice names beside the shared entries:
 * `tool_failed`, its fallback (OD-6).
 */
export const filesToolCatalog: ErrorCatalog = {
  tool_failed: { title: 'Tool failed', retryable: false },
};

/**
 * The edit block's rule: open while the call runs, and open once settled until
 * the reader folds it, so the diff stands visible; never open with nothing to
 * show.
 */
export const editOpenness = (
  status: ToolStatus,
  args: string,
  result?: string,
  error?: ErrorInfo,
): Openness => ({
  active: status === 'running',
  hasContent: args.length > 0 || result !== undefined || error !== undefined,
  defaultOpen: true,
});

type EditToolItemProps = {
  /** The tool's name, shown as the failure notice's `Tool` context. */
  readonly name: 'edit' | 'write';
  readonly args: string;
  readonly error?: ErrorInfo;
  readonly result?: string;
  readonly status: ToolStatus;
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  readonly focused?: boolean;
};

const lineRowClass = (kind: DiffLine['kind']): string => {
  if (kind === 'add') {
    return 'bg-[color-mix(in_oklab,var(--paper-green)_12%,transparent)] text-foreground';
  }
  if (kind === 'remove') {
    return 'bg-[color-mix(in_oklab,var(--paper-red)_12%,transparent)] text-foreground';
  }
  return 'text-muted-foreground';
};

const lineMarker = (kind: DiffLine['kind']): string => {
  if (kind === 'add') return '+';
  if (kind === 'remove') return '-';
  return ' ';
};

const lineMarkerClass = (kind: DiffLine['kind']): string => {
  if (kind === 'add') return 'text-[var(--paper-green)]';
  if (kind === 'remove') return 'text-[var(--paper-red)]';
  return 'text-muted-foreground/60';
};

/**
 * An `edit` or `write` tool call rendered as a standalone file-diff block in the
 * transcript: its header shows the file name and `+added / −removed` counts,
 * and its body renders the unified diff lines directly below without a card or
 * vertical guide line.
 */
export const EditToolItem = memo(function EditToolItem({
  args,
  chosen,
  error,
  focused,
  name,
  onChosenChange,
  result,
  status,
}: EditToolItemProps) {
  const running = status === 'running';
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo(
    () => parseEditCall(args, result, error?.message),
    [args, result, error],
  );
  // The output's own report carries no time the component can read (§6.1).
  const notice = useMemo(
    () =>
      error ??
      (parsed.error !== undefined && parsed.error.length > 0
        ? errorInfo(parsed.error, { at: null })
        : undefined),
    [error, parsed.error],
  );
  const failed = status === 'failed' || parsed.success === false;
  const verb = running ? 'Editing' : failed ? 'Failed to edit' : 'Edited';
  const hasCounts = parsed.added > 0 || parsed.removed > 0;
  const openness = editOpenness(status, args, result, error);
  const open = blockOpen(chosen, openness);
  const hiddenCount = Math.max(0, parsed.diffLines.length - INITIAL_DIFF_LINES);
  const canToggleMore = hiddenCount > 0;
  const visibleLines =
    canToggleMore && !expanded
      ? parsed.diffLines.slice(0, INITIAL_DIFF_LINES)
      : parsed.diffLines;

  const label = (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle font-light">
      <span className="shrink-0 font-normal">{verb}</span>
      {parsed.fileName !== undefined ? (
        <span data-slot="edit-file-name" className="truncate font-mono">
          {parsed.fileName}
        </span>
      ) : (
        <span>file</span>
      )}
      {hasCounts ? (
        <span
          data-slot="edit-counts"
          className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums"
        >
          <span className="text-[var(--paper-green)]">+{parsed.added}</span>
          <span className="text-[var(--paper-red)]">−{parsed.removed}</span>
        </span>
      ) : null}
    </span>
  );

  return (
    <div data-slot="edit-tool">
      <CollapsibleBlock
        chosen={chosen}
        focused={focused}
        guide={false}
        label={label}
        onChosenChange={onChosenChange}
        openness={openness}
      >
        {open ? (
          <div className="flex flex-col gap-1.5">
            {notice === undefined ? null : (
              <ErrorNotice
                variant="compact"
                error={notice}
                catalog={filesToolCatalog}
                fallbackCode="tool_failed"
                context={{ Tool: name }}
              />
            )}
            {parsed.diffLines.length > 0 ? (
              <div data-slot="edit-diff" className="font-mono text-sm">
                {visibleLines.map((line, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static positional rows of one tool result
                    key={index}
                    data-slot="edit-diff-line"
                    data-kind={line.kind}
                    className={cn(
                      'flex w-full items-baseline leading-relaxed',
                      lineRowClass(line.kind),
                    )}
                  >
                    <span className="min-w-[5ch] w-13 shrink-0 select-none whitespace-nowrap pr-2 text-right tabular-nums text-muted-foreground/70">
                      {line.lineNumber ?? ''}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        'w-4 shrink-0 select-none text-center',
                        lineMarkerClass(line.kind),
                      )}
                    >
                      {lineMarker(line.kind)}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">
                      {line.text}
                    </span>
                  </div>
                ))}
                {canToggleMore ? (
                  <button
                    type="button"
                    data-slot="edit-diff-more"
                    className="flex w-full cursor-pointer items-center gap-2 py-1 text-left font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setExpanded((prev) => !prev)}
                  >
                    {expanded
                      ? '⋯ Show less'
                      : `⋯ Show ${hiddenCount} more ${hiddenCount === 1 ? 'line' : 'lines'}`}
                  </button>
                ) : null}
              </div>
            ) : parsed.rawOutput !== undefined &&
              parsed.rawOutput.length > 0 ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-sm text-muted-foreground">
                {parsed.rawOutput}
              </pre>
            ) : null}
          </div>
        ) : null}
      </CollapsibleBlock>
    </div>
  );
});

/** What the chat sets on the element. */
interface EditCallProps {
  readonly view?: ChatToolView;
}

/**
 * Draws the row of the element's `view` and reports the reader's choice from
 * its root, whose parent is the element: the event bubbles to the element,
 * where the chat keeps it.
 */
function EditCall({ view }: EditCallProps) {
  const root = useRef<HTMLDivElement>(null);
  const onChosenChange = useCallback((chosen: boolean) => {
    root.current?.dispatchEvent(
      new CustomEvent<{ readonly chosen: boolean }>(CHAT_BLOCK_CHOSEN_EVENT, {
        detail: { chosen },
        bubbles: true,
        composed: true,
      }),
    );
  }, []);
  if (view === undefined) return null;
  return (
    <div ref={root} className="contents">
      <EditToolItem
        name={view.name === 'write' ? 'write' : 'edit'}
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
 * The `files-edit-call` element class: maps `view` (`ChatToolView`) to the
 * row and dispatches `chat-block-chosen` for the reader's choice. No
 * `toggle()`: the chat's generic answer with `openByDefault` is the edit's
 * own rule.
 */
export const defineEditCallElement = () =>
  defineReactElement<EditCallProps>({
    props: ['view'],
    render: EditCall,
  });
