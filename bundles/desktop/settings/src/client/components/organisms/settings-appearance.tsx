import type { DoricAppearance } from 'bundle/contracts';
import { Field, FieldError, FieldGroup, FieldLabel } from 'desktop/ui/field';
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
 * row. It reads the theme each time it mounts; while a read or a save is
 * pending the tiles are disabled, and the selected tile moves only once the
 * app saved the choice (§4.1). The app repaints every window itself.
 */
export function SettingsAppearance({
  appearance,
}: {
  readonly appearance: DoricAppearance;
}) {
  const [theme, setTheme] = useState<Theme>();
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
          if (mounted.current) setTheme(answer.theme);
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
        {message !== undefined && <FieldError>{message}</FieldError>}
      </Field>
    </FieldGroup>
  );
}
