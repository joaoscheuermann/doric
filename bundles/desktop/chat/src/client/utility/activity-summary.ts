/**
 * How a completed burst reads as one line: "Thought 3 times, called 5 tools". A
 * clause is left out when its count is none, and a single act reads as one.
 */
export const activitySummary = (thoughts: number, tools: number): string => {
  const parts: string[] = [];
  if (thoughts > 0)
    parts.push(thoughts === 1 ? 'thought once' : `thought ${thoughts} times`);
  if (tools > 0)
    parts.push(tools === 1 ? 'called 1 tool' : `called ${tools} tools`);

  const summary = parts.join(', ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
};
