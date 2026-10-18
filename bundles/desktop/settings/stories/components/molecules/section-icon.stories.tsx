import { sectionIcon } from '../../../src/client/components/molecules/section-icon.js';
import { controlFrame } from '../../support/frames.js';

/** Every icon name a `settings-link` may carry, then one the map lacks. */
const names = ['server', 'zap', 'wrench', 'git-branch', 'key-round', 'globe'];

/** The icon a name resolves to, beside the name, as the nav and headings draw it. */
function SectionIcons() {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {names.map((name) => {
        const Icon = sectionIcon(name);
        return (
          <li key={name} className="flex items-center gap-2">
            {Icon === undefined ? (
              <span className="size-4 rounded-sm border border-dashed" />
            ) : (
              <Icon aria-hidden className="size-4" />
            )}
            <code className="text-xs text-muted-foreground">{name}</code>
            {Icon === undefined && (
              <span className="text-xs text-muted-foreground">
                (not in the map, so no icon)
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A section heading as the settings window draws it. */
function Heading({
  name,
  label,
}: {
  readonly name: string;
  readonly label: string;
}) {
  const Icon = sectionIcon(name);
  return (
    <header className="flex items-center gap-2">
      {Icon !== undefined && <Icon aria-hidden className="size-5 shrink-0" />}
      <h1 className="text-lg font-medium">{label}</h1>
    </header>
  );
}

export default {
  title: 'Settings/Molecules/Section icon',
  decorators: [controlFrame],
};

export const AllIcons = {
  render: () => <SectionIcons />,
};

export const InAHeading = {
  render: () => <Heading name="key-round" label="Credentials" />,
};
