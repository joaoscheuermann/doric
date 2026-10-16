import { ProjectAvatar } from '../../../src/client/components/molecules/project-avatar.js';
import { projectColors } from '../../../src/client/domain/workspace.js';

export default {
  title: 'Layout/Molecules/Project avatar',
  component: ProjectAvatar,
};

export const Color = {
  render: () => <ProjectAvatar color="violet" />,
};

/** No color set: the hollow ring. */
export const NoColor = {
  render: () => <ProjectAvatar />,
};

/** Every color of the palette, in palette order. */
export const Palette = {
  render: () => (
    <div className="flex items-center gap-3">
      <ProjectAvatar />
      {projectColors.map((color) => (
        <ProjectAvatar key={color} color={color} />
      ))}
    </div>
  ),
};

/** The smaller mark the Project tabs use. */
export const TabSize = {
  render: () => (
    <div className="flex items-center gap-3">
      {projectColors.map((color) => (
        <ProjectAvatar key={color} color={color} className="size-[12px]" />
      ))}
    </div>
  ),
};

/** On the sidebar background, where the ring reads against the sidebar. */
export const OnSidebar = {
  render: () => (
    <div className="flex w-60 flex-col gap-2 bg-sidebar p-3 text-xs text-sidebar-foreground">
      <span className="flex items-center gap-2">
        <ProjectAvatar color="teal" /> Docs site
      </span>
      <span className="flex items-center gap-2">
        <ProjectAvatar /> Mobile onboarding
      </span>
    </div>
  ),
};
