{{!
  A mid-run "Skills changed" message. skills/catalog.ts supplies only data: per non-empty list of
  added skills, its kind, the rows that fit (cells on one line, capped and pipe-escaped) and how
  many were dropped; and the ids of the listed skills that went away.
}}
# Skills changed

The skills you can load with load_skill changed. This message updates the skills listed in your instructions and in earlier "Skills changed" messages.
{{#added}}

## Added

Each skill below is listed by its id and a description of when it applies. When a task matches a description, call load_skill with that id before you start that part of the work, and follow the instructions it returns.
{{#lists}}

{{#workspace}}
### Workspace skills

From `.agents/skills` in the current working directory.
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
{{/added}}
{{#removed}}

## No longer available

These skills can no longer be loaded:

{{#skills}}
- `{{locator}}`
{{/skills}}
{{/removed}}
