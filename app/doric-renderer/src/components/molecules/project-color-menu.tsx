import { ProjectAvatar } from '@/components/molecules/project-avatar';
import {
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { type ProjectColor, projectColors } from '@/domain/workspace';

type ProjectColorMenuProps = {
  readonly onSelect: (color?: ProjectColor) => void;
  readonly value?: ProjectColor;
};

/** The radio value that means "no color", which the palette itself never holds. */
const noColor = 'no-color';

const colorLabel = (color: string): string =>
  color.charAt(0).toUpperCase() + color.slice(1);

/**
 * A Project's color, chosen from the fixed palette: the submenu a project row's
 * context menu opens. Only palette values travel back — picking "No color"
 * clears the field instead of assigning a default.
 */
export function ProjectColorMenu({ onSelect, value }: ProjectColorMenuProps) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <ProjectAvatar color={value} />
        Color
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuRadioGroup
          value={value ?? noColor}
          onValueChange={(next) =>
            onSelect(next === noColor ? undefined : (next as ProjectColor))
          }
        >
          <ContextMenuRadioItem value={noColor}>No color</ContextMenuRadioItem>
          <ContextMenuSeparator />
          {projectColors.map((color) => (
            <ContextMenuRadioItem key={color} value={color}>
              <ProjectAvatar color={color} />
              {colorLabel(color)}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
