// Where the Versioning section lives: the settings window's content column,
// under the heading its settings link gives it.

import type { ComponentType } from 'react';

export const settingsDecorators = [
  (Story: ComponentType) => (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">Versioning</h1>
        <p className="text-sm text-muted-foreground">
          Which stored credentials the agent commits and pushes with inside a
          Project.
        </p>
      </div>
      <Story />
    </div>
  ),
];
