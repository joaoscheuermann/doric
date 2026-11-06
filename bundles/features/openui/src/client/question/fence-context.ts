// The fence context (conversation-openui.md D29), in the renderer chunk:
// what `ConversationFence` provides around `Renderer` and `AskForm`'s
// component reads, since `Renderer` passes components their props only.

import type { Services } from 'bundle/contracts';
import { createContext, useContext } from 'react';

import type { ProgramRevision } from '../../contracts/index.js';
import type { ChatFenceView } from '../chat-contract.js';
import type { WatchAnswers } from '../chunks/renderer.js';

export interface FenceContextValue {
  readonly view: ChatFenceView;
  readonly revision: ProgramRevision;
  readonly superseded: boolean;
  readonly services: Services;
  readonly watchAnswers: WatchAnswers;
}

export const FenceContext = createContext<FenceContextValue | undefined>(
  undefined,
);

/** The fence being drawn, or `undefined` outside `ConversationFence`. */
export const useFence = (): FenceContextValue | undefined =>
  useContext(FenceContext);
