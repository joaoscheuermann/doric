import { sectionPath } from './section-route.js';

/** The icon names a `settings-link` may carry (D9-15). */
export type SectionIconName =
  | 'user'
  | 'server'
  | 'zap'
  | 'wrench'
  | 'git-branch'
  | 'key-round';

export interface SettingsSectionEntry {
  readonly id: 'profile' | 'providers' | 'execution' | 'tools' | 'credentials';
  readonly label: string;
  readonly icon: SectionIconName;
  readonly order: number;
  /**
   * The sentence the nav searches beside the label, so a reader finds a section
   * by what it explains — "turns", "push" — not only by the one word it is
   * named after.
   */
  readonly description: string;
}

/** The sections this window offers, in the order the nav lists them. */
export const sections = [
  {
    id: 'profile',
    label: 'Profile',
    icon: 'user',
    order: 5,
    description:
      "Your name and time zone for the agent's prompts; with no time zone chosen, the host's own applies.",
  },
  {
    id: 'providers',
    label: 'Providers',
    icon: 'server',
    order: 10,
    description:
      'Every provider Doric may call, and the credential each one authenticates with.',
  },
  {
    id: 'execution',
    label: 'Execution',
    icon: 'zap',
    order: 20,
    description:
      'What runs a prompt: the provider, the model on it, its reasoning effort, and how many turns one prompt may take.',
  },
  {
    id: 'tools',
    label: 'Tools',
    icon: 'wrench',
    order: 30,
    description:
      'Configuration for the tools the loaded bundles expose, each describing the fields it reads.',
  },
  // Versioning (order 40) is the git bundle's `/settings/git` section (WP-10N).
  {
    id: 'credentials',
    label: 'Credentials',
    icon: 'key-round',
    order: 50,
    description:
      'Secrets the host stores and never sends back. A provider and the Git integrations each choose the credential they use, so a key is entered once here and named everywhere it applies.',
  },
] as const satisfies readonly SettingsSectionEntry[];

/** The `settings.sections` region item of one section. */
export const sectionLink = (section: SettingsSectionEntry) => ({
  id: section.id,
  tag: 'settings-link',
  order: section.order,
  props: {
    label: section.label,
    path: sectionPath(section.id),
    icon: section.icon,
    description: section.description,
  },
});
