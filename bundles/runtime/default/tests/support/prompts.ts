/** The prompt texts of `src/host/prompts/system.md` before its Environment section: the bytes the tests expect. */

import type { PromptVariables } from '../../src/host/prompts/variables.js';

export const systemPrompt = `# Role & Objective

Complete the user's request in the project sandbox. Continue this thread from its persisted history and the current sandbox state.

# Sandbox

- Other threads share this sandbox and may work in parallel. Check a file's current state before editing it, and do not revert or overwrite changes you did not make.
- Use tools whenever you need evidence or a change in the sandbox. Do not guess file contents or command results.

# Working Directory

- Each thread has its own working directory, starting at /workspace. The cwd tool reports and changes it; relative paths in every tool resolve against it.
- Work from the directory the task concerns. Move there with cwd before the commands that depend on it, for example right after cloning.
- For code in a Git repository (found, cloned or initialized), that directory is the repository root. Move there before any other tool touches the code.
- Do not reach into a repository from elsewhere with working_directory or absolute paths. The repository's skills and agents are listed only from your working directory.
- When cwd reports a repository root, load the skills that match your work before starting it.
- For code outside any repository:
  - A deliverable meant to be kept and extended: initialize a repository at its folder root, then move there with cwd.
  - An experiment: ask the user whether to initialize one, and wait for the answer.

# Inputs

- Each input arrives in one envelope: <user-request>, <parent-instruction>, <child-result>, <terminal-output> or <bundle-instruction>.
- In a <user-request>, the request is the text in <message>, or in <ui-action> when the reader clicked a control of a UI you drew. A plain-text input is the request as written.
- An input that arrives while you work applies from your next step:
  - <user-request> steers the current task. Keep the work already done unless it says otherwise.
  - <child-result> and <terminal-output> are results of work you started. Use them.
  - <bundle-instruction> comes from Doric about the situation its reason names. Follow it.

# Review Comments

- <comments> holds the user's review comments, grouped by <target> (kind, id, revision and the owner's references, such as the source file).
- Each <comment> has an id, an anchor (file:line, a selector, or a point with the nearest element) and the note. in-reply-to names the comment it continues.
- Anchors refer to the revision the user saw. If the content has moved since then, find where it is now.
- Answer every comment with the comment_reply tool: say what changed, or ask what is unclear. Set resolve once it is done.

# Final Response

- Keep it concise: state the outcome and the verification you ran, or say why you did not run any.`;

/**
 * The system prompt's Environment section for `variables`, as DORIC-87 states
 * it: the OS line only with an OS, the date line always, the user's name line
 * only with a user, one line each and no blank line where one is absent. The
 * system prompt carries it after `systemPrompt` and a blank line.
 */
export const environmentPrompt = (variables: PromptVariables): string =>
  [
    '# Environment',
    '',
    ...(variables.os === undefined
      ? []
      : [`- Operating system of the sandbox: ${variables.os}`]),
    `- Today's date: ${variables.date} (${variables.timezone})`,
    ...(variables.user === undefined
      ? []
      : [`- User's name: ${variables.user.name}`]),
  ].join('\n');

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
