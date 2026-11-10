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
import { useMemo } from 'react';

import {
  type Configuration,
  type ProviderKind,
  providerLabel,
} from '../../domain/config.js';
import { providerIconRequest } from '../../domain/model-icons.js';
import { useModelIcons } from '../../hooks/use-model-icons.js';
import { ProviderIcon } from '../molecules/provider-icon.js';

/**
 * A provider row, at the metrics of the Projects group's rows drawn right above
 * it (the prototype `85:7520`): 28 px tall, 6 px side inset, 6 px from the mark
 * to a 13 px regular name.
 */
const row =
  'h-7 gap-1.5 px-1.5 py-0 text-[13px] font-normal data-active:font-normal [&_svg]:size-3.5';

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
  // One request per provider shown, kept while the providers are the same.
  const providers = draft?.providers;
  const requests = useMemo(
    () => (providers ?? []).map(providerIconRequest),
    [providers],
  );
  const icons = useModelIcons(requests);

  return (
    <Collapsible defaultOpen className="group/collapsible">
      {/* The Projects group's own metrics (`85:7520`): no inset, a 20 px
          label 4 px above the rows, the "+" at its top right. */}
      <SidebarGroup className="gap-1 p-0">
        <SidebarGroupLabel
          render={<CollapsibleTrigger />}
          className="h-5 gap-1 pl-1.5 font-normal"
        >
          <ChevronRightIcon className="transition-transform group-data-[open]/collapsible:rotate-90" />
          Providers
        </SidebarGroupLabel>
        <SidebarGroupAction
          className="top-0 right-1"
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
                  <SidebarMenuSkeleton
                    showIcon
                    className="h-7 gap-1.5 px-1.5"
                  />
                </SidebarMenuItem>
              ) : (
                draft.providers.map((provider, index) => (
                  <SidebarMenuItem key={provider.id}>
                    <SidebarMenuButton
                      isActive={index === activeIndex}
                      onClick={() => onOpen(index)}
                      className={row}
                    >
                      <ProviderIcon
                        svg={
                          icons === undefined
                            ? undefined
                            : (icons.provider(provider.id) ?? null)
                        }
                        className="size-3.5"
                      />
                      <span>{providerLabel(provider, index)}</span>
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
