{{!
  The "# Skills" section of the system prompt. skills/catalog.ts supplies only data: the
  always-available skills that fit and, per non-empty list, its kind, the rows that fit (cells on
  one line, capped and pipe-escaped) and how many were dropped.
}}
# Skills
{{#alwaysAvailable}}

## Always-available skills

Follow these skills whenever they apply.
{{#skills}}

### Skill: {{name}}

{{body}}
{{/skills}}
{{/alwaysAvailable}}
{{#toLoad}}

## Skills to load

Each skill below is listed by its id and a description of when it applies. When a task matches a description, call load_skill with that id before you start that part of the work, and follow the instructions it returns. Load only the skills the task needs.
{{#lists}}

{{#builtIn}}
### Built-in skills
{{/builtIn}}
{{#workspace}}
### Workspace skills

From `.agents/skills` in the working directory this prompt started in.
{{/workspace}}
{{#server}}
### MCP server skills

Served by the Project's MCP servers.
{{/server}}
{{#table}}

| Skill | Description |
| --- | --- |
{{#rows}}
| {{locator}} | {{description}} |
{{/rows}}
{{/table}}
{{#dropped}}

{{count}} more {{#one}}skill{{/one}}{{^one}}skills{{/one}} did not fit in this list.
{{/dropped}}
{{/lists}}
{{/toLoad}}
