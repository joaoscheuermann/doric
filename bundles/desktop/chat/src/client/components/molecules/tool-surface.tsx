import type { ErrorInfo } from 'desktop/reads';
import type { Chosen } from 'desktop/ui/collapsible-block';
import { type JSX, useContext, useMemo } from 'react';

import type { ChatToolView } from '../../../contracts/index.js';
import type { ToolStatus } from '../../domain/projector.js';
import { toolDrawing } from '../../domain/tool-drawing.js';
import { useToolRenderers } from '../../hooks/use-drawings.js';
import { ChatBlocksContext } from '../organisms/conversation/nodes/chat-block-node.js';
import { ToolItem } from './tool-item.js';
import { ViewElement } from './view-element.js';

/**
 * One tool call as the window draws it now (`chat.views/v1` 1.2.0): the element
 * a bundle registered for the tool, with the call's `view`, or else the chat's
 * own row, open by default as `toolDrawing` answers. The registry is read live,
 * so a registration's arrival or departure redraws the call at once.
 */
export function ToolSurface({
  promptId,
  callId,
  name,
  args,
  status,
  result,
  error,
  chosen,
  focused,
  toggleKey,
  onChosenChange,
}: {
  readonly promptId: string;
  readonly callId: string;
  readonly name: string;
  readonly args: string;
  readonly status: ToolStatus;
  readonly result?: string;
  readonly error?: ErrorInfo;
  readonly chosen: Chosen;
  readonly focused: boolean;
  /** The key the conversation's toggle key reaches a registered element by. */
  readonly toggleKey: string;
  readonly onChosenChange: (chosen: boolean) => void;
}): JSX.Element {
  const renderers = useToolRenderers();
  const drawing = toolDrawing(name, renderers);
  const { projectId, threadId } = useContext(ChatBlocksContext);
  // One `view` per change of a field the element reads, so an element is not
  // handed a new object on every render of its block.
  const view = useMemo<ChatToolView>(
    () => ({
      projectId: projectId ?? '',
      threadId: threadId ?? '',
      promptId,
      key: `${promptId}/${callId}`,
      name,
      args,
      status,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
      chosen,
      focused,
    }),
    [
      projectId,
      threadId,
      promptId,
      callId,
      name,
      args,
      status,
      result,
      error,
      chosen,
      focused,
    ],
  );

  if (drawing.elementTag === undefined)
    return (
      <ToolItem
        args={args}
        chosen={chosen}
        error={error}
        focused={focused}
        generic={renderers.has(name)}
        name={name}
        onChosenChange={onChosenChange}
        openByDefault={drawing.openByDefault}
        result={result}
        status={status}
      />
    );
  return (
    <ViewElement
      tag={drawing.elementTag}
      view={view}
      toggleKey={toggleKey}
      onChosen={onChosenChange}
    />
  );
}
