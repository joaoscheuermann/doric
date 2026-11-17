import { Tabs, TabsList, TabsTrigger } from 'desktop/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import { ArchiveIcon, MessageCircleIcon } from 'lucide-react';

import type { SidebarTab } from '../../domain/thread-archive.js';

const SIDEBAR_TABS = [
  { value: 'chat', label: 'Chat', Icon: MessageCircleIcon },
  { value: 'archived', label: 'Archived', Icon: ArchiveIcon },
] as const;

/**
 * §10.2: the sidebar's Chat and Archived tabs, icon-only, each named and with
 * a tooltip, without a counter (U1).
 */
export function SidebarTabs({
  value,
  onChange,
}: {
  readonly value: SidebarTab;
  readonly onChange: (tab: SidebarTab) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onChange(next === 'archived' ? next : 'chat')}
    >
      <TabsList className="w-full">
        {SIDEBAR_TABS.map(({ value: tab, label, Icon }) => (
          <Tooltip key={tab}>
            <TooltipTrigger
              render={<TabsTrigger value={tab} aria-label={label} />}
            >
              <Icon />
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </TabsList>
    </Tabs>
  );
}
