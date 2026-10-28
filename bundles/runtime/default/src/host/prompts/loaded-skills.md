{{!
  The body of the loaded-skills message that replaces the skills a compaction summarized.
  skills/loaded.ts supplies only data: per kept skill, its text, a fence longer than any backtick
  run in it and whether it was cut; and the ids of the skills that did not fit.
}}
# Loaded skills

Earlier messages were summarized. The skills below were loaded in them and are still in effect: follow them wherever they apply. Do not load them again, unless one is marked as cut and you need the part that is missing.
{{#entries}}

{{fence}}text
{{text}}
{{#cut}}

[Cut to fit. Load this skill again with load_skill for the whole text.]
{{/cut}}
{{fence}}
{{/entries}}
{{#omitted}}

These skills were loaded too but did not fit here; load one again with load_skill if you need it:

{{#skills}}
- `{{locator}}`
{{/skills}}
{{/omitted}}
