// Reading the failure notices and toasts a settings window draws
// (error-messages.md §3, §4): each notice is a `[data-slot="error-notice"]`
// whose title the notice names with `aria-labelledby`, whose Retry and Copy
// details are icon buttons named by `aria-label`, and whose details open
// behind a "Details" button into a `<pre aria-label="Error details">`. A
// failure toast is a `[data-slot="error-toast"]` holding one notice; the ids of
// the toasts on screen are read from the window's own `toast` state.

import { settle } from './window.js';

/** Every failure notice inside `root`, in document order. */
export const noticesIn = (
  root: ParentNode | null | undefined,
): HTMLElement[] =>
  root === null || root === undefined
    ? []
    : [...root.querySelectorAll<HTMLElement>('[data-slot="error-notice"]')];

/** The notice's title, as the element its `aria-labelledby` names reads. */
export const titleOf = (notice: HTMLElement): string | undefined => {
  const id = notice.getAttribute('aria-labelledby');
  if (id === null) return undefined;
  return (
    notice.ownerDocument.getElementById(id)?.textContent?.trim() ?? undefined
  );
};

/** The notice's explanation, as the element its `aria-describedby` names reads. */
export const explanationOf = (notice: HTMLElement): string | undefined => {
  const id = notice.getAttribute('aria-describedby');
  if (id === null) return undefined;
  return (
    notice.ownerDocument.getElementById(id)?.textContent?.trim() ?? undefined
  );
};

/** The notices inside `root` whose title is `title`. */
export const noticesTitled = (
  root: ParentNode | null | undefined,
  title: string,
): HTMLElement[] =>
  noticesIn(root).filter((notice) => titleOf(notice) === title);

/** The notice's Retry button, when it offers one. */
export const retryOf = (notice: HTMLElement): HTMLButtonElement | null =>
  notice.querySelector<HTMLButtonElement>('button[aria-label="Retry"]');

/** Whether the notice announces itself (`announce`, §3.6). */
export const announced = (notice: HTMLElement): boolean =>
  notice.getAttribute('role') === 'alert';

/** Opens the notice's details and answers the text they hold. */
export const detailsOf = async (notice: HTMLElement): Promise<string> => {
  const trigger = [
    ...notice.querySelectorAll<HTMLButtonElement>('button'),
  ].find((button) => button.textContent?.trim() === 'Details');
  if (trigger !== undefined) {
    trigger.click();
    await settle(50);
  }
  return (
    notice.querySelector('pre[aria-label="Error details"]')?.textContent ?? ''
  );
};

/** The `Time:` line of the notice's details, when they hold one. */
export const timeOf = async (
  notice: HTMLElement,
): Promise<string | undefined> =>
  /^Time: (.+)$/m.exec(await detailsOf(notice))?.[1];

/** The part of `desktop/ui/sonner` these tests read. */
interface SonnerModule {
  readonly Toaster: () => unknown;
  readonly toast: {
    getToasts(): readonly {
      readonly id: string | number;
      readonly title?: unknown;
    }[];
    dismiss(id?: string | number): void;
  };
}

/** The window's toasts: the ones `toast` holds now, and the ones drawn. */
export interface Toasts {
  /** The ids of the toasts shown now, oldest first. */
  ids(): string[];
  /** The titles of the toasts shown now, as `toast` holds them. */
  titles(): string[];
  /** The failure toasts drawn now. */
  surfaces(): HTMLElement[];
  /** Every toast drawn now that is not leaving, failure or not. */
  drawn(): HTMLElement[];
  /** Dismisses every toast, for the next test. */
  dismissAll(): void;
}

/**
 * The toasts of the window open now. The settings part's `toast` is the one
 * `desktop/ui/sonner` exports, the module this process shares with it; a
 * window without a `Toaster` of its own (the dashboard, the footer) gets one
 * mounted with `mount`.
 */
export const windowToasts = async (
  document: Document,
  options: { readonly mount?: boolean } = {},
): Promise<Toasts> => {
  // Imported by name at run time: the module is the one the shipped part
  // resolves, and this test project compiles no `.tsx` source of it.
  const specifier = 'desktop/ui/sonner';
  const sonner = (await import(specifier)) as SonnerModule;
  if (options.mount === true) {
    const [{ createRoot }, { createElement }] = await Promise.all([
      import('react-dom/client'),
      import('react'),
    ]);
    const holder = document.createElement('div');
    document.body.append(holder);
    createRoot(holder).render(
      createElement(sonner.Toaster as unknown as () => null),
    );
    await settle(50);
  }
  return {
    ids: () => sonner.toast.getToasts().map((entry) => String(entry.id)),
    titles: () =>
      sonner.toast
        .getToasts()
        .map((entry) => (typeof entry.title === 'string' ? entry.title : '')),
    surfaces: () => [
      ...document.querySelectorAll<HTMLElement>('[data-slot="error-toast"]'),
    ],
    drawn: () => [
      ...document.querySelectorAll<HTMLElement>(
        '[data-sonner-toast]:not([data-removed="true"])',
      ),
    ],
    dismissAll: () => {
      sonner.toast.dismiss();
    },
  };
};
