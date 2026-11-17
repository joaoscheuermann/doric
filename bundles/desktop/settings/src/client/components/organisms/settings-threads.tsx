import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from 'desktop/ui/field';
import { Switch } from 'desktop/ui/switch';

import {
  type AutoArchive,
  autoArchiveOf,
  type Configuration,
  updateAutoArchive,
} from '../../domain/config.js';
import { ChoiceList } from '../molecules/choice-list.js';

type SettingsThreadsProps = {
  readonly draft: Configuration;
  readonly onChange: (next: Configuration) => void;
};

/** The main-thread choices, in the order the section lists them. */
const mainThreadsChoices: readonly {
  readonly label: string;
  readonly note?: string;
  readonly value: Required<AutoArchive>['mainThreadsAfter'];
}[] = [
  { label: '1 day', value: '1d' },
  { label: '7 days', note: 'default', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: 'Never', value: 'never' },
];

/**
 * The Threads section: an "Auto-archive" group with a switch for archiving
 * finished agent threads and a choice of when inactive main threads move to
 * Archived ("1 day", "7 days" noted "default", "30 days", "Never"). It reads
 * the policy through `autoArchiveOf(draft)`, so an absent policy shows the
 * defaults, and every change calls `onChange` once with
 * `updateAutoArchive(draft, change)`; the window's draft autosaves it like any
 * other section. It never calls the host itself.
 */
export function SettingsThreads({ draft, onChange }: SettingsThreadsProps) {
  const policy = autoArchiveOf(draft);

  return (
    <FieldSet>
      <FieldLegend>Auto-archive</FieldLegend>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="threads-agent-threads">
              Archive finished agent threads
            </FieldLabel>
            <FieldDescription>
              Moves an agent thread to Archived about 30 seconds after its work
              finishes. It comes back on its own when it gets new work, from its
              parent or from you.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="threads-agent-threads"
            checked={policy.agentThreads}
            onCheckedChange={(agentThreads) =>
              onChange(updateAutoArchive(draft, { agentThreads }))
            }
          />
        </Field>
        <FieldSeparator />
        <Field>
          <FieldTitle>Archive inactive main threads after</FieldTitle>
          <ChoiceList
            choices={mainThreadsChoices}
            value={policy.mainThreadsAfter}
            onSelect={(chosen) => {
              const choice = mainThreadsChoices.find(
                ({ value }) => value === chosen,
              );
              if (choice !== undefined) {
                onChange(
                  updateAutoArchive(draft, { mainThreadsAfter: choice.value }),
                );
              }
            }}
          />
          <FieldDescription>
            Inactive means no messages, answers or running child threads for
            that long. A main thread is never archived automatically while it or
            a child thread has a failure, a pending action or question, an
            unread result or a pin.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
