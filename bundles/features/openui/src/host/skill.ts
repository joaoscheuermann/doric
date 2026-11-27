// The `openui` skill (openui.md D17; phase 3, S56, D4): its constants and
// the skill built from its text.

/** The skill's text, relative to the bundle directory; what `host.assets` must match (S62: `["src/host/skills/*.md"]`). */
export const OPENUI_SKILL_PATH = 'src/host/skills/openui.md';

/** D17's registration options: listed in the index, loaded on demand. */
export const OPENUI_SKILL_OPTIONS: {
  readonly order: 3400;
  readonly alwaysAvailable: false;
} = { order: 3400, alwaysAvailable: false };

/** D17's `openui` skill: today's name, description and no allowed tools. */
export interface OpenuiSkill {
  readonly name: 'openui';
  readonly description: string;
  readonly allowedTools: readonly [];
  readonly body: string;
}

/** The skill whose body is `text` trimmed. Pure; never throws. */
export const openuiSkillOf = (text: string): OpenuiSkill => ({
  name: 'openui',
  description:
    'Answers with UI the app draws while you write: OpenUI Lang programs in openui-lang fences, with forms, tables, charts and question forms for the reader. Load it before writing an openui-lang or papercraft fence, or before asking the reader to decide something.',
  allowedTools: [],
  body: text.trim(),
});
