// The reader's open/closed choice a folding block's owner holds (in the app,
// the Lexical node's state), held here in React state so a story's chevron
// works the way the conversation's does.

import { type ReactNode, useState } from 'react';

import type { Chosen } from '../../src/client/domain/collapsible.js';

export function WithChosen({
  initial = null,
  children,
}: {
  /** The reader's choice before the story starts; `null` lets the work decide. */
  readonly initial?: Chosen;
  readonly children: (
    chosen: Chosen,
    onChosenChange: (chosen: boolean) => void,
  ) => ReactNode;
}) {
  const [chosen, setChosen] = useState<Chosen>(initial);
  return <>{children(chosen, setChosen)}</>;
}
