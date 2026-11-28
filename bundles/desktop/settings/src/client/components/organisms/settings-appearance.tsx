import type { DoricAppearance, DoricGlass } from 'bundle/contracts';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from 'desktop/ui/field';
import { Switch } from 'desktop/ui/switch';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { type Theme, themes } from '../../api/appearance.js';
import { ThemeOption } from '../molecules/theme-option.js';

const READ_FAILED = 'Could not read the appearance.';
const SAVE_FAILED = 'Could not save the appearance. Try again.';

/** The keys that move the selection to the previous or the next tile. */
const steps: Readonly<Record<string, -1 | 1>> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

/**
 * The Appearance section (`65:13666`): the Theme field's three tiles in a
 * row, then, when the app answers `glass` (platform 1.12.0), a "Frosted glass"
 * switch. It reads the preference each time it mounts; while a read or a save
 * is pending the tiles and the switch are disabled, and each moves only once
 * the app saved the choice (§4.1). The app repaints every window itself. On a
 * system that cannot draw the glass the switch shows off and disabled, and
 * says why.
 */
export function SettingsAppearance({
  appearance,
}: {
  readonly appearance: DoricAppearance;
}) {
  const [theme, setTheme] = useState<Theme>();
  const [glass, setGlass] = useState<DoricGlass>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string>();
  const mounted = useRef(true);
  const tiles = useRef(new Map<Theme, HTMLButtonElement>());
  // The section's stub may change identity between renders; the calls are
  // the same contract's.
  const contract = useRef(appearance);
  contract.current = appearance;

  useEffect(() => {
    mounted.current = true;
    contract.current
      .get()
      .then(
        (answer) => {
          if (!mounted.current) return;
          setTheme(answer.theme);
          setGlass(answer.glass);
        },
        () => {
          if (mounted.current) setMessage(READ_FAILED);
        },
      )
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  const choose = (next: Theme): void => {
    if (busy || next === theme) return;
    setBusy(true);
    contract.current
      .set({ theme: next })
      .then(
        () => {
          if (!mounted.current) return;
          setTheme(next);
          setMessage(undefined);
        },
        () => {
          if (mounted.current) setMessage(SAVE_FAILED);
        },
      )
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const toggleGlass = (enabled: boolean): void => {
    if (busy || glass === undefined || !glass.supported) return;
    setBusy(true);
    contract.current
      .set({ glass: enabled })
      .then(
        () => {
          if (!mounted.current) return;
          setGlass({ ...glass, enabled });
          setMessage(undefined);
        },
        () => {
          if (mounted.current) setMessage(SAVE_FAILED);
        },
      )
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  // Arrow keys move along the group and choose, as in any radio group.
  const step = (from: Theme, event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = steps[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const index = themes.indexOf(from);
    const next = themes[(index + delta + themes.length) % themes.length];
    if (next === undefined) return;
    tiles.current.get(next)?.focus();
    choose(next);
  };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel id="appearance-theme">Theme</FieldLabel>
        <div
          role="radiogroup"
          aria-labelledby="appearance-theme"
          aria-busy={busy}
          className="flex items-stretch gap-3"
        >
          {themes.map((option) => (
            <ThemeOption
              key={option}
              ref={(element) => {
                if (element === null) tiles.current.delete(option);
                else tiles.current.set(option, element);
              }}
              theme={option}
              selected={option === theme}
              disabled={busy}
              focusable={option === (theme ?? themes[0])}
              onSelect={() => choose(option)}
              onKeyDown={(event) => step(option, event)}
            />
          ))}
        </div>
      </Field>
      {glass !== undefined && (
        <>
          <FieldSeparator />
          <Field orientation="horizontal" data-disabled={!glass.supported}>
            <FieldContent>
              <FieldLabel htmlFor="appearance-glass">Frosted glass</FieldLabel>
              <FieldDescription>
                {glass.supported
                  ? 'Shows the desktop behind the window, blurred, around the sidebar and the bars.'
                  : 'Needs macOS or Windows 11 version 22H2 or later.'}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="appearance-glass"
              checked={glass.supported && glass.enabled}
              disabled={busy || !glass.supported}
              onCheckedChange={toggleGlass}
            />
          </Field>
        </>
      )}
      {message !== undefined && <FieldError>{message}</FieldError>}
    </FieldGroup>
  );
}
