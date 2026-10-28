{{!
  A mid-run "Agents changed" message. agents/catalog.ts supplies only data: the rows of the added or
  changed agents that fit (cells on one line, capped and pipe-escaped) and how many were dropped; and
  the names of the agents that went away.
}}
# Agents changed

The agents defined for this thread changed with its working directory. This message updates the agents listed in your instructions and in earlier "Agents changed" messages.
{{#added}}

## Added or changed

| Agent | Description |
| --- | --- |
{{#rows}}
| {{name}} | {{description}} |
{{/rows}}
{{#dropped}}

{{count}} more {{#one}}agent{{/one}}{{^one}}agents{{/one}} did not fit.
{{/dropped}}
{{/added}}
{{#removed}}

## No longer available

{{#agents}}
- `{{name}}`
{{/agents}}
{{/removed}}
