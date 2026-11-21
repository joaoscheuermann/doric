// The toasts the element raises, as the settings window's `Toaster` draws
// them (error-messages.md §3, §4): the element's `toast` is the one
// `desktop/ui/sonner` exports, the module this process shares with it, so a
// `Toaster` mounted here draws what the element asks for. A failure toast is a
// `[data-slot="error-toast"]` holding one `[data-slot="error-notice"]`, whose
// title and explanation the notice names by `aria-labelledby` and
// `aria-describedby`.

import { settle } from './render.js';

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

/** The part of `desktop/ui/sonner` these tests read. */
interface SonnerModule {
  readonly Toaster: () => unknown;
  readonly toast: {
    getToasts(): readonly { readonly id: string | number }[];
    dismiss(id?: string | number): void;
  };
}

/** The window's toasts: the ones `toast` holds now, and the ones drawn. */
export interface Toasts {
  /** The ids of the toasts shown now, oldest first. */
  ids(): string[];
  /** The failure toasts drawn now. */
  surfaces(): HTMLElement[];
  /** Every toast drawn now that is not leaving, failure or not. */
  drawn(): HTMLElement[];
  /** Dismisses every toast, for the next test. */
  dismissAll(): void;
}

let toaster: Promise<SonnerModule> | undefined;

/** Mounts one `Toaster` in the installed window's body, once per process. */
const mountToaster = async (): Promise<SonnerModule> => {
  // Imported by name at run time: the module is the one the element resolves.
  const specifier = 'desktop/ui/sonner';
  const sonner = (await import(specifier)) as SonnerModule;
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
  return sonner;
};

/** The toasts of the installed window, drawn by a `Toaster` of its own. */
export const windowToasts = async (): Promise<Toasts> => {
  toaster ??= mountToaster();
  const sonner = await toaster;
  return {
    ids: () => sonner.toast.getToasts().map((entry) => String(entry.id)),
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
