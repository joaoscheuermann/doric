import { Button } from 'desktop/ui/button';
import { type DiffControls, DiffEditor, fileLanguage } from 'desktop/ui/code';
import { ToolbarDivider } from 'desktop/ui/panels';
import { ToggleGroup, ToggleGroupItem } from 'desktop/ui/toggle-group';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';

import { chromeBarEdited, chromeBarSource } from '../support/doric.js';

export default {
  title: 'desktop/ui/Code/Diff editor',
  component: DiffEditor,
};

/** The Git bundle's added and deleted colours (`--git-added`, `--git-deleted`). */
const diffTokens = {
  added: 'oklch(0.6 0.15 150)',
  removed: 'oklch(0.6 0.19 27)',
};

const path = 'packages/desktop/src/chrome-bar.tsx';

const Toolbar = ({ controls }: { readonly controls: DiffControls }) => (
  <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
    <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label="Previous change"
      onClick={() => controls.onNavigate('previous')}
    >
      <ChevronUpIcon />
    </Button>
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label="Next change"
      onClick={() => controls.onNavigate('next')}
    >
      <ChevronDownIcon />
    </Button>
    <ToolbarDivider />
    <ToggleGroup
      size="sm"
      value={[controls.layout]}
      onValueChange={(values) => {
        const [value] = values;
        if (value !== undefined) controls.onLayout(value);
      }}
      aria-label="Diff layout"
    >
      <ToggleGroupItem value="unified">Unified</ToggleGroupItem>
      <ToggleGroupItem value="split">Split</ToggleGroupItem>
    </ToggleGroup>
  </div>
);

const Footer = ({ controls }: { readonly controls: DiffControls }) => (
  <div className="flex h-7 shrink-0 items-center gap-2 border-t px-2 text-xs text-muted-foreground">
    {controls.counts === undefined ? (
      <span>Comparing…</span>
    ) : (
      <>
        <span className="text-[oklch(0.6_0.15_150)]">
          +{controls.counts.added}
        </span>
        <span className="text-[oklch(0.6_0.19_27)]">
          −{controls.counts.removed}
        </span>
      </>
    )}
  </div>
);

const Frame = ({
  original,
  modified,
}: {
  readonly original: string;
  readonly modified: string;
}) => (
  <div className="flex h-[30rem] flex-col overflow-hidden rounded-lg border">
    <DiffEditor
      original={original}
      modified={modified}
      language={fileLanguage(path)}
      diffTokens={diffTokens}
      toolbar={(controls) => <Toolbar controls={controls} />}
      footer={(controls) => <Footer controls={controls} />}
    />
  </div>
);

export const Modified = {
  render: () => <Frame original={chromeBarSource} modified={chromeBarEdited} />,
};

export const Added = {
  render: () => <Frame original="" modified={chromeBarSource} />,
};

export const Deleted = {
  render: () => <Frame original={chromeBarSource} modified="" />,
};

export const Unchanged = {
  render: () => <Frame original={chromeBarSource} modified={chromeBarSource} />,
};
