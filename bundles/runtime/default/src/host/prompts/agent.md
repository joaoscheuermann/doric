{{!
  The "# Agent" section of the system prompt, for a thread that runs as an agent; it comes before
  "# Agents". executor.ts supplies only data: the agent's name, and its instructions already
  rendered with the run's prompt variables.
}}
# Agent: {{name}}

You run as the {{name}} agent. Follow these instructions; they take precedence over general guidance for how to do your task.

{{instructions}}
