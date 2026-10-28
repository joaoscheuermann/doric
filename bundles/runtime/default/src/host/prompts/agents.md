{{!
  The "# Agents" section of the system prompt. agents/catalog.ts supplies only data: the rows that
  fit (cells on one line, capped and pipe-escaped) and how many were dropped.
}}
# Agents

The agents defined for this thread, each by its name and a description of when to use it.

| Agent | Description |
| --- | --- |
{{#rows}}
| {{name}} | {{description}} |
{{/rows}}
{{#dropped}}

{{count}} more {{#one}}agent{{/one}}{{^one}}agents{{/one}} did not fit.
{{/dropped}}
