// The fence context (conversation-openui.md D29), in the renderer chunk:
// what `ConversationFence` provides around `Renderer` and what `AskForm`'s
// and `Flowchart`'s components read, since `Renderer` passes components
// their props only.

import type { Services } from 'bundle/contracts';
import { createContext, useContext } from 'react';

import type { ProgramRevision } from '../../contracts/index.js';
import type { ChatFenceView } from '../chat-contract.js';
import type { WatchAnswers } from '../chunks/renderer.js';
import type { LayoutGraph, LayoutResult } from '../diagram/layout-types.js';

export interface FenceContextValue {
  readonly view: ChatFenceView;
  readonly revision: ProgramRevision;
  readonly superseded: boolean;
  readonly services: Services;
  readonly watchAnswers: WatchAnswers;
  /** The diagram is interactive (Terms): `blockedReason(view, latest)` gives `undefined`. */
  readonly interactive: boolean;
  /** The window's layout loader (F6), or the fence's `layout` prop. */
  readonly layout: (graph: LayoutGraph) => Promise<LayoutResult>;
}

export const FenceContext = createContext<FenceContextValue | undefined>(
  undefined,
);

/** The fence being drawn, or `undefined` outside `ConversationFence`. */
export const useFence = (): FenceContextValue | undefined =>
  useContext(FenceContext);
