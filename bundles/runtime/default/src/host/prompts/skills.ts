/** The heading that opens the skills section of the system prompt. */
export const skillsPrompt = `# Skills`;

/** Opens the always-available skills; each skill follows as `### Skill: <name>` and its body. */
export const alwaysAvailableSkillsPrompt = `## Always-available skills

Follow these skills whenever they apply.`;

/** Opens the catalog lists, before the first of them. */
export const skillsToLoadPrompt = `## Skills to load

Each skill below is listed by its id and a description of when it applies. When a task matches a description, call load_skill with that id before you start that part of the work, and follow the instructions it returns. Load only the skills the task needs.`;

/** Heading of the bundles' skills list (no intro line). */
export const builtInSkillsPrompt = `### Built-in skills`;

/** Heading and intro of the working directory's `.agents/skills` list. */
export const workspaceSkillsPrompt = `### Workspace skills

From \`.agents/skills\` in the working directory this prompt started in.`;

/** Heading and intro of the connected MCP servers' skills list. */
export const serverSkillsPrompt = `### MCP server skills

Served by the Project's MCP servers.`;

/** Opens a mid-run "Skills changed" message, before its added and removed parts. */
export const skillsChangedPrompt = `# Skills changed

The skills you can load with load_skill changed. This message updates the skills listed in your instructions and in earlier "Skills changed" messages.`;

/** Opens the lists of the skills a "Skills changed" message adds. */
export const addedSkillsPrompt = `## Added

Each skill below is listed by its id and a description of when it applies. When a task matches a description, call load_skill with that id before you start that part of the work, and follow the instructions it returns.`;

/** Heading and intro of the added workspace skills of a "Skills changed" message. */
export const changedWorkspaceSkillsPrompt = `### Workspace skills

From \`.agents/skills\` in the current working directory.`;

/** Opens the list of the skills a "Skills changed" message removes, one id per line after it. */
export const removedSkillsPrompt = `## No longer available

These skills can no longer be loaded:`;

/** Opens the message that keeps the skills loaded before a compaction, before their texts. */
export const loadedSkillsPrompt = `# Loaded skills

Earlier messages were summarized. The skills below were loaded in them and are still in effect: follow them wherever they apply. Do not load them again, unless one is marked as cut and you need the part that is missing.`;

/** Ends a loaded skill's text the loaded-skills message cut. */
export const loadedSkillCutPrompt = `[Cut to fit. Load this skill again with load_skill for the whole text.]`;

/** Opens the ids of the loaded skills the loaded-skills message had no room for. */
export const loadedSkillsOmittedPrompt = `These skills were loaded too but did not fit here; load one again with load_skill if you need it:`;

/** The `load_skill` tool's description. */
export const loadSkillPrompt = `Loads a skill listed under "Skills to load" in your instructions or in a later "Skills changed" message, and returns its instructions. Call it before starting work that a listed skill's description matches.`;

/** The description of `load_skill`'s `name` field. */
export const loadSkillNamePrompt =
  "The skill's id, as listed in the Skill column.";
