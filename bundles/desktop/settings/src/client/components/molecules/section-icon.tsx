import {
  GitBranchIcon,
  KeyRoundIcon,
  type LucideIcon,
  ServerIcon,
  WrenchIcon,
  ZapIcon,
} from 'lucide-react';

const icons: Readonly<Record<string, LucideIcon>> = {
  server: ServerIcon,
  zap: ZapIcon,
  wrench: WrenchIcon,
  'git-branch': GitBranchIcon,
  'key-round': KeyRoundIcon,
};

/** The icon a section is named by, from the fixed map of `settings-link` (D9-15). */
export const sectionIcon = (
  name: string | undefined,
): LucideIcon | undefined => (name === undefined ? undefined : icons[name]);
