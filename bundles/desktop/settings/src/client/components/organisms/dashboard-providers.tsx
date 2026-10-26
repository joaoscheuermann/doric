import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from 'desktop/ui/sidebar';
import { ChevronRightIcon, PlusIcon } from 'lucide-react';

import {
  type Configuration,
  type ProviderKind,
  providerLabel,
} from '../../domain/config.js';
import { ProviderIcon } from '../molecules/provider-icon.js';

/**
 * The dashboard sidebar's Providers group: one row per configured provider,
 * drawn by its mark and name, which opens that provider's page; the row of the
 * open page is the active one. The group folds from its label, and its "+"
 * opens a page for a new provider (none while the host lists no kind). A
 * skeleton row stands in while the configuration is still arriving.
 */
export function DashboardProvidersGroup({
  draft,
  kinds,
  activeIndex,
  onOpen,
  onAdd,
}: {
  readonly draft: Configuration | undefined;
  readonly kinds: readonly ProviderKind[];
  readonly activeIndex: number | undefined;
  readonly onOpen: (index: number) => void;
  readonly onAdd: () => void;
}) {
  return (
    <Collapsible defaultOpen className="group/collapsible">
      <SidebarGroup>
        <SidebarGroupLabel
          render={<CollapsibleTrigger />}
          className="gap-1 font-normal"
        >
          <ChevronRightIcon className="transition-transform group-data-[open]/collapsible:rotate-90" />
          Providers
        </SidebarGroupLabel>
        <SidebarGroupAction
          title="Add provider"
          aria-label="Add provider"
          disabled={kinds.length === 0}
          onClick={onAdd}
        >
          <PlusIcon />
        </SidebarGroupAction>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {draft === undefined ? (
                <SidebarMenuItem>
                  <SidebarMenuSkeleton showIcon />
                </SidebarMenuItem>
              ) : (
                draft.providers.map((provider, index) => (
                  <SidebarMenuItem key={provider.id}>
                    <SidebarMenuButton
                      isActive={index === activeIndex}
                      onClick={() => onOpen(index)}
                      className="data-active:font-normal [&_svg]:size-3.5"
                    >
                      <ProviderIcon
                        kind={provider.kind}
                        endpoint={provider.configuration.endpoint}
                      />
                      <span className="font-light">
                        {providerLabel(provider, index)}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}
