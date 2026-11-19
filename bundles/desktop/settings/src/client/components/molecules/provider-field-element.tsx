import type { Ui } from 'bundle/contracts';
import { type JSX, useEffect, useRef } from 'react';

import type { ProviderFieldView } from '../../../contracts/index.js';

/** The event an item of `settings.provider.field` answers the page with. */
const answerEvent = 'settings-provider-field';

/** An element created for an item, as the page holds it. */
interface FieldHost {
  view?: ProviderFieldView;
}

const answerOf = (event: Event): string | undefined => {
  const detail = (event as CustomEvent<{ readonly value?: unknown } | null>)
    .detail;
  return typeof detail?.value === 'string' ? detail.value : undefined;
};

/** Creates `tag` through `ui` with `{ view }`, sets `view` on change, hands each `settings-provider-field` value to `onAnswer` (stopping the event at its frame), disposes on unmount. A failed creation is logged and draws nothing. */
export function ProviderFieldElement({
  ui,
  tag,
  view,
  onAnswer,
}: {
  readonly ui: Ui;
  readonly tag: string;
  readonly view: ProviderFieldView;
  readonly onAnswer: (value: string) => void;
}): JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const created = useRef<FieldHost | null>(null);
  const latest = useRef({ view, onAnswer });
  latest.current = { view, onAnswer };

  useEffect(() => {
    const host = frame.current;
    if (host === null) return;
    let element: FieldHost;
    try {
      element = ui.create(tag, { view: latest.current.view }) as FieldHost;
    } catch (error) {
      console.error(`Doric: the element <${tag}> could not be created:`, error);
      return;
    }
    if (element.view !== latest.current.view)
      element.view = latest.current.view;
    created.current = element;
    host.replaceChildren(element as unknown as Node);
    return () => {
      if (created.current === element) created.current = null;
      (element as unknown as ChildNode).remove();
      ui.dispose(element);
    };
  }, [ui, tag]);

  useEffect(() => {
    const element = created.current;
    if (element !== null && element.view !== view) element.view = view;
  }, [view]);

  useEffect(() => {
    const host = frame.current;
    if (host === null) return;
    const listener = (event: Event): void => {
      // The answer is this field's: it goes no further than its frame.
      event.stopPropagation();
      const value = answerOf(event);
      if (value !== undefined) latest.current.onAnswer(value);
    };
    host.addEventListener(answerEvent, listener);
    return () => host.removeEventListener(answerEvent, listener);
  }, []);

  return <div ref={frame} className="contents" />;
}
