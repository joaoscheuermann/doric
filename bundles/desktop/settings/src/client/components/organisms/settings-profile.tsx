import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from 'desktop/ui/combobox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from 'desktop/ui/field';
import { Input } from 'desktop/ui/input';

import {
  type Configuration,
  timeZoneChoices,
  updateProfileName,
  updateProfileTimezone,
} from '../../domain/config.js';

type SettingsProfileProps = {
  readonly draft: Configuration;
  readonly onChange: (next: Configuration) => void;
};

/** The label of the time zone choice that stores none: the host's applies. */
const hostZoneLabel = 'Host time zone';

/**
 * Who the agent's prompts speak for: a name, and the time zone dates are read in.
 * The first time zone choice, `''`, clears the zone so the host's applies.
 */
export function SettingsProfile({ draft, onChange }: SettingsProfileProps) {
  const timezone = draft.profile?.timezone;
  const zones = [
    '',
    ...timeZoneChoices(Intl.supportedValuesOf('timeZone'), timezone),
  ];
  const zoneLabel = (zone: string): string =>
    zone === '' ? hostZoneLabel : zone;

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="profile-name">Name</FieldLabel>
        <Input
          id="profile-name"
          autoComplete="off"
          value={draft.profile?.name ?? ''}
          onChange={(event) =>
            onChange(updateProfileName(draft, event.target.value))
          }
        />
        <FieldDescription>
          The name the agent's prompts call you by. Leave it empty for none.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="profile-timezone">Time zone</FieldLabel>
        <Combobox
          items={zones}
          itemToStringLabel={zoneLabel}
          value={timezone ?? ''}
          onValueChange={(chosen) => {
            if (chosen !== null) {
              onChange(updateProfileTimezone(draft, chosen));
            }
          }}
        >
          <ComboboxInput id="profile-timezone" placeholder={hostZoneLabel} />
          <ComboboxContent>
            <ComboboxEmpty>No time zone matches.</ComboboxEmpty>
            <ComboboxList>
              {(zone: string) => (
                <ComboboxItem key={zone} value={zone}>
                  {zoneLabel(zone)}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <FieldDescription>
          The time zone dates in the agent's prompts are read in. The host time
          zone applies until you choose one.
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
