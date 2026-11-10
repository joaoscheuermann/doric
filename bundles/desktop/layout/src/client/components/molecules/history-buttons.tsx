import {
  type Navigation,
  type NavigationHistory,
  NavigationV1,
  navigationMethods,
} from 'bundle/contracts';
import { Button } from 'desktop/ui/button';
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { layoutServices } from '../../services/layout-services.js';

/** What `HistoryButtons` needs of `desktop/ui/button-group`. */
export type ButtonGroupModule = Pick<
  typeof import('desktop/ui/button-group'),
  'ButtonGroup'
>;

export type HistoryButtonsProps = {
  /**
   * Loads `desktop/ui/button-group`. A rejection (an app before
   * `PLATFORM_VERSION` 1.4.0 has no such module) draws nothing.
   */
  readonly load?: () => Promise<ButtonGroupModule>;
  /**
   * Whether the app's `navigationMethods` lists `history` (and `forward`,
   * which came with it in `navigation/v1@1.1.0`). False draws nothing.
   */
  readonly historyMethods?: boolean;
};

let buttonGroup: Promise<ButtonGroupModule> | undefined;

/**
 * Imports `desktop/ui/button-group` once per window. The import is dynamic so
 * that an app without the module fails this promise alone, never the layout's
 * whole client part (S35).
 */
export const loadButtonGroup = (): Promise<ButtonGroupModule> => {
  buttonGroup ??= import('desktop/ui/button-group');
  return buttonGroup;
};

/** The window's navigation, or none outside an active layout. */
const useNavigation = (): Navigation | undefined =>
  useMemo(() => {
    try {
      return layoutServices().use(NavigationV1);
    } catch {
      return undefined;
    }
  }, []);

/**
 * `history()`'s answer, or none when the provider cannot give it: an older
 * core on a newer app lists the method but its provider throws `unavailable`.
 */
const readHistory = (
  navigation: Navigation | undefined,
): NavigationHistory | undefined => {
  if (navigation === undefined) return undefined;
  try {
    return navigation.history();
  } catch {
    return undefined;
  }
};

/**
 * Back and Forward, the sidebar header's history group (§4.2, Figma
 * `349:95622`): a ButtonGroup of two ghost `icon-sm` buttons, lucide
 * `ArrowLeftIcon` / `ArrowRightIcon` at 14 px, named "Back" and "Forward".
 *
 * - Each is disabled while `navigation/v1`'s `history()` says it cannot move;
 *   the answer is read again after every `subscribe` notice (S11, S12).
 * - Pressing one calls `back()` or `forward()` once.
 * - Draws nothing until `load` settles, nothing when it rejects, when
 *   `historyMethods` is false, or when `history()` throws (S35).
 * - The outer corners keep Figma's 4 px (`--radius-md`); shadcn's group
 *   rounds them at `--radius-lg`.
 */
export function HistoryButtons({
  load = loadButtonGroup,
  historyMethods = Object.hasOwn(navigationMethods, 'history'),
}: HistoryButtonsProps): ReactNode {
  const navigation = useNavigation();
  const [module, setModule] = useState<ButtonGroupModule>();
  const [history, setHistory] = useState<NavigationHistory | undefined>();

  useEffect(() => {
    if (!historyMethods) return;
    let live = true;
    load().then(
      (loaded) => {
        if (live) setModule(loaded);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [load, historyMethods]);

  useEffect(() => {
    if (!historyMethods || navigation === undefined) return;
    setHistory(readHistory(navigation));
    const subscription = navigation.subscribe(() =>
      setHistory(readHistory(navigation)),
    );
    return () => subscription.dispose();
  }, [navigation, historyMethods]);

  if (
    !historyMethods ||
    module === undefined ||
    history === undefined ||
    navigation === undefined
  ) {
    return null;
  }
  const { ButtonGroup } = module;
  const button =
    '[-webkit-app-region:no-drag] in-data-[slot=button-group]:rounded-md';
  return (
    <ButtonGroup
      aria-label="History"
      className="[&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-md!"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back"
        title="Back"
        disabled={!history.canGoBack}
        className={button}
        onClick={() => navigation.back()}
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Forward"
        title="Forward"
        disabled={!history.canGoForward}
        className={button}
        onClick={() => navigation.forward()}
      >
        <ArrowRightIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </ButtonGroup>
  );
}
