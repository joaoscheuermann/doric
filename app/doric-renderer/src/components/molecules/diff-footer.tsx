import {
  ArrowDownIcon,
  ArrowUpIcon,
  Columns2Icon,
  Rows2Icon,
} from 'lucide-react';

import type { DiffControls } from '@/components/molecules/diff-editor';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** The path gives way to controls when the reading column is narrow. */
export function DiffFooter({
  path,
  controls,
}: {
  readonly path: string;
  readonly controls?: DiffControls;
}) {
  const navigationDisabled =
    !controls?.counts || controls.counts.added + controls.counts.removed === 0;
  return (
    <footer
      data-slot="diff-footer"
      className="flex chrome-bar min-w-0 shrink-0 items-center gap-2 border-t px-3"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
        {path}
      </span>
      {controls && (
        <div className="flex shrink-0 items-center gap-1">
          <ToggleGroup
            type="single"
            size="sm"
            value={controls.layout}
            onValueChange={(value) => {
              if (value) controls.onLayout(value);
            }}
            aria-label="Diff layout"
          >
            <ToggleGroupItem
              value="unified"
              aria-label="Unified diff"
              title="Unified diff"
            >
              <Rows2Icon />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="split"
              aria-label="Side by side diff"
              title="Side by side when space allows; unified below 700 px"
            >
              <Columns2Icon />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous change"
            title="Previous change"
            disabled={navigationDisabled}
            onClick={() => controls.onNavigate('previous')}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next change"
            title="Next change"
            disabled={navigationDisabled}
            onClick={() => controls.onNavigate('next')}
          >
            <ArrowDownIcon />
          </Button>
        </div>
      )}
    </footer>
  );
}
