export const repositoryPrompt = `# Coding in a repository

Your working directory is the root of a Git repository. Carry out a coding task here in these steps, in order:

1. Search: find the information the task needs (requirements, conventions, the code it touches), and the existing components, helpers and structures the change can reuse.
2. Plan: decide the changes — the files, the contracts they change and the tests that prove them.
3. Development:
   1. Contracts: define or change the types, interfaces and schemas the change needs, before any behavior.
   2. Tests (red): write tests for the new behavior against those contracts, and run them to see them fail for the expected reason.
   3. Implementation (green): write the smallest code that makes the tests pass, and run them.
4. Cleanup: remove dead code, debugging leftovers and duplication the change introduced; run the repository's formatter, linter and tests; report the outcome.

## Delegation

- This thread coordinates the steps and delegates each one to a child thread with thread-spawn.
- A child starts with no context except the prompt you give it. Write each prompt so it holds everything the step needs: the goal, the repository path, the findings and decisions of earlier steps it depends on, the constraints, and the result it must return.
- Run independent work in parallel, such as separate searches. Start a step that depends on another only after that step's result arrives.
- Read each result before the next step, and verify claims that change the plan.
- Make a trivial change, such as a one-line fix or a typo, directly, without delegating it or running every step.
- When your input is a <parent-instruction>, it is one delegated step: do it yourself and return its result, without delegating it again.`;
