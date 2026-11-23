// D28's `papercraft` skill: its constants, the skill built from the committed
// text, and the kernel's read of that text beside this module (S57 D5).

import { readFileSync } from 'node:fs';

/** What `host.assets` must match (S62: `"src/host/skills/*.md"`). */
export const PAPERCRAFT_SKILL_PATH = 'src/host/skills/papercraft.md';

/** D28's options: after `openui`'s 3400, listed and loaded on demand. */
export const PAPERCRAFT_SKILL_OPTIONS: {
  readonly order: 3410;
  readonly alwaysAvailable: false;
} = { order: 3410, alwaysAvailable: false };

/** D28's `papercraft` skill: today's name and description, `allowedTools ['comment_reply']`. */
export interface PapercraftSkill {
  readonly name: 'papercraft';
  readonly description: string;
  readonly allowedTools: readonly ['comment_reply'];
  readonly body: string;
}

/** The skill whose body is `text` trimmed. Pure; never throws. */
export const papercraftSkillOf = (text: string): PapercraftSkill => ({
  name: 'papercraft',
  description:
    'Previews repository components and exports live in the conversation: OpenUI Lang programs in papercraft fences, with the repository library, Export and pinned comments. Load it before writing a papercraft fence.',
  allowedTools: ['comment_reply'],
  body: text.trim(),
});

/** `./skills/papercraft.md` read synchronously beside this module; throws the read error (`ENOENT`). No read at import. */
export const readSkillBesideModule = (): string =>
  readFileSync(new URL('./skills/papercraft.md', import.meta.url), 'utf8');
