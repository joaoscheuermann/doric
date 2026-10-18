# Sexy TypeScript

Use these rules when writing or refactoring TypeScript. The outcome is code that keeps domain logic predictable, minimizes hidden state, and expresses transformations through values instead of stepwise mutation.

This is the TypeScript-specific implementation polish layer for the coding-conventions skill. Do not apply TypeScript-only mechanics mechanically to Rust, Python, or other languages. For mixed-language work, preserve the invariant intent and express it in the target language's idioms.

## Success criteria

- Core domain logic is written as a functional core with imperative boundaries.
- Functions prefer inputs in, values out, and no hidden mutation, I/O, time, random, process, network, or filesystem dependencies.
- Values are immutable by default with `const`, readonly types, and structural sharing where practical.
- Collection transformations use declarative array methods when they make intent clearer than manual loops.
- Side effects are isolated at explicit boundaries such as adapters, handlers, composition roots, framework callbacks, or tool implementations.
- Classes are used only when extending an existing class-based contract is necessary for correct runtime behavior.
- Nx TypeScript packages keep `src/lib/` organized with `classes/` for required classes, `types/` for shared type contracts, and `utils/` for supporting helpers, so the main implementation file stays small and focused.
- Imperative code is used deliberately when it is clearer, faster, easier to debug, or required by an API.

## Retrieval & stop rules

This reference is self-contained. Stop reading once these success criteria and decision rules are enough to make the TypeScript code idiomatic for the current task. Look elsewhere only when project-specific APIs, framework behavior, or existing patterns would materially affect the implementation.

## Decision rules

### Prefer functional programming over imperative programming

Prefer functional programming over imperative programming for TypeScript domain logic.

Write code as small pure functions that transform input values into output values. Push mutation, I/O, logging, caching, timers, randomness, process state, filesystem access, network access, and framework side effects to the edges of the module or package.

```ts
type Invoice = {
  readonly id: string;
  readonly subtotal: number;
  readonly taxRate: number;
};

type Totals = {
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
};

export const calculateTotals = (invoice: Invoice): Totals => {
  const tax = invoice.subtotal * invoice.taxRate;

  return {
    subtotal: invoice.subtotal,
    tax,
    total: invoice.subtotal + tax,
  };
};
```

Prefer expression-oriented transforms over stepwise mutation when the expression is easier to scan.

```ts
const activeUserIds = users
  .filter((user) => user.status === 'active')
  .map((user) => user.id);
```

Use an explicit loop or local mutation when it communicates the algorithm better, avoids unnecessary allocations, handles complex early exits, or keeps async and side-effect ordering obvious.

```ts
const firstInvalid = (items: readonly Item[]): Item | undefined => {
  for (const item of items) {
    if (!isValid(item)) {
      return item;
    }
  }

  return undefined;
};
```

Do not optimize for code that only looks functional. Avoid dense chains, clever `reduce` calls, point-free style, unnecessary currying, and abstraction-heavy helper layers when named intermediate values or a plain function would be clearer.

### Sexy Packages

When working in an Nx TypeScript package, keep `src/lib/` organized by concern so the main implementation file does not become a dumping ground.

Use `src/lib/classes/` for classes that are required by runtime contracts, such as `Error` subclasses, framework base-class adapters, stream subclasses, or other APIs where subclassing is the behavior. Do not introduce classes only to satisfy the folder structure.

Use `src/lib/types/` for shared TypeScript contracts, including exported `type` aliases, interfaces, discriminated unions, and reusable readonly data shapes. Keep domain types close to the feature when they are private and tiny, but move them into `types/` once they are shared, exported, or distracting from the implementation flow.

Use `src/lib/utils/` for supporting methods and helper functions that keep the main implementation readable. A utility should still have a clear purpose, descriptive name, and narrow caller set; do not use `utils/` to hide unrelated behavior or avoid creating a cohesive feature module.

Keep the package entrypoint and main implementation file focused on public exports, composition, and readable orchestration. Prefer files such as:

```text
packages/<name>/
  src/
    index.ts
    lib/
      <name>.ts
      classes/
        parse-error.ts
      types/
        parse-result.ts
      utils/
        format-message.ts
```

The goal is separation of concerns: type contracts live in `types/`, necessary class adapters live in `classes/`, supporting helpers live in `utils/`, and behavior remains in cohesive implementation modules.

### Avoid classes unless subclassing is required

Do not introduce classes for domain modeling, service objects, dependency containers, namespaces, state bags, or ordinary polymorphism. Prefer plain objects, functions, closures, interfaces, discriminated unions, and explicit dependency parameters.

Classes are permitted only when extending an existing class-based runtime or library contract is the behavior that makes the code work. Valid examples include extending `Error` to preserve JavaScript error semantics, extending Node.js stream classes such as `Readable`, `Writable`, or `Transform`, or extending a framework base class when the framework requires subclassing for lifecycle behavior.

When a class is necessary, keep it as a thin adapter around the required inheritance point. Put core behavior in pure functions that can be tested without constructing the subclass.

```ts
type ParseIssue = {
  readonly path: string;
  readonly message: string;
};

const formatParseMessage = (issues: readonly ParseIssue[]): string =>
  issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');

export class ParseError extends Error {
  readonly issues: readonly ParseIssue[];

  constructor(issues: readonly ParseIssue[]) {
    super(formatParseMessage(issues));
    this.name = 'ParseError';
    this.issues = issues;
  }
}
```
