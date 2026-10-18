# GPT-5.5 Prompting Optimizations

GPT-5.5 performs best when allowed to decide its own path to a clearly defined goal. Avoid "legacy prompt" patterns that treat the LLM like it needs rigid micromanagement.

## 1. Outcome-First Goals

**Avoid process-heavy checklists.** Older models needed instructions like _"First inspect A, then B, then think about exceptions, then call tool."_
**Do this instead:** Define what the final destination looks like. Give the model a `Success criteria` block and let it choose the optimal path and tools to get there.

## 2. Retrieval Budgets (Stopping Conditions)

Because agents load files progressively, a skill must define when to _stop_ reading. Unbounded search instructions cause wasted tool loops.

- **Include explicit stop rules:** Tell the agent to "use the minimum evidence sufficient to answer correctly, then stop."
- **Example:** "Make another retrieval call only when a required fact or explicit parameter is missing."

## 3. Progressive Disclosure & Tool Loops

The Agent Skills spec encourages splitting knowledge into `references/*.md`. However, GPT-5.5 is heavily penalized in time-to-first-token if it has to make 10 consecutive tool calls to read 10 tiny reference files.

- **Rule of thumb:** Consolidate tightly related concepts into a single reference file. For example, merge `srp.md`, `ocp.md`, and `dip.md` into one `architecture-principles.md`.

## 4. Absolute Rules and Tone

- **Do not use screaming caps** (e.g., "YOU MUST ALWAYS", "NEVER DO THIS") unless it is a severe safety or security invariant. For coding boundaries, label strict requirements as a **Repository Invariant**—GPT-5.5 respects this naturally without the noise.
- **Decision rules over absolutes:** For judgment calls, provide "Decision Rules" (e.g., "Prefer adding a new target over a mega-script") instead of strict `ALWAYS/NEVER` instructions.

## 5. Preambles

If a skill requires heavy tool usage or multi-step analysis, tell the agent to output a "Preamble" (a 1-2 sentence update acknowledging the request and stating the first step) before invoking tools. This improves the perceived latency for the end-user.
