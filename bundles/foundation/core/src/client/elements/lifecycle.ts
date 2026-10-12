// Shared by the core's structural elements: `display: contents` (set when
// connected: a custom element constructor may not add attributes), and the
// deferred teardown of a disconnection, so a move within the document
// (disconnect then connect in the same task) keeps what was rendered.

export const showContents = (element: HTMLElement): void => {
  if (element.style.display !== 'contents') {
    element.style.display = 'contents';
  }
};

export const afterDisconnect = (
  element: HTMLElement,
  teardown: () => void,
): void => {
  queueMicrotask(() => {
    if (!element.isConnected) {
      teardown();
    }
  });
};
