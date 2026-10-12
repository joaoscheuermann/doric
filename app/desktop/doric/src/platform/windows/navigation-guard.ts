// P7: a renderer may not navigate its window anywhere but where it is, and
// may not open windows. Main's own `loadURL` is not renderer-initiated.

export interface GuardedContents {
  getURL(): string;
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
}

export const installNavigationGuard = (contents: GuardedContents): void => {
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
};
