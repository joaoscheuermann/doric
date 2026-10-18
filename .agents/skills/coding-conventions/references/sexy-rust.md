# Sexy Rust

Use these rules only when writing or refactoring Rust. The outcome is code that uses Rust's type system to make invalid states hard or impossible, keeps control flow flat, and reads clearly at API boundaries and call sites.

This is the Rust-specific implementation polish layer for the coding-conventions skill. Do not apply Rust-only mechanics such as typestate, `?`, `Option`/`Result` combinators, or conversion traits to TypeScript, JavaScript, Python, or other languages. For mixed-language work, keep the invariant intent and translate it into the target language's idioms.

## Success criteria

- Domain invariants are encoded in types near system boundaries instead of repeatedly validated in core logic.
- Functions prefer expression-oriented Rust, implicit tail returns, and scoped blocks that keep temporary setup local.
- Error and optional-value handling stays flat with `?`, `ok_or`, `map`, `and_then`, `unwrap_or_else`, `if let`, `while let`, and focused `match` expressions.
- Core domain transformations are functional where practical: inputs in, values out, narrow side effects, and immutable bindings by default.
- Collection transformations prefer clear iterator chains over mutable tracking variables when the iterator version is simpler to read.
- APIs feel natural at call sites by using standard conversion traits such as `From`, `Into`, and `AsRef` where they clarify boundaries.
- State-dependent APIs use typestate or equivalent type-level modeling when compile-time state restrictions materially improve correctness.
- Code is formatted with `rustfmt` and checked with `clippy` where project tooling supports it.

## Retrieval & stop rules

This reference is self-contained. Stop reading once these success criteria and decision rules are enough to make the Rust code idiomatic for the current task. Look elsewhere only when project-specific APIs, crate behavior, or existing patterns would materially affect the implementation.

## Decision rules

### Type-driven design

Prefer parsing raw input into strong domain types at the boundary. Let the type system carry guarantees through the rest of the code.

Use enums, newtypes, and constructors returning `Result` or `Option` to make illegal states unrepresentable.

```rust
struct PositiveAmount(f64);

impl PositiveAmount {
    fn new(value: f64) -> Result<Self, &'static str> {
        if value > 0.0 {
            Ok(Self(value))
        } else {
            Err("amount must be positive")
        }
    }
}

fn process(amount: PositiveAmount, currency: Currency) {
    // Core logic receives validated data by construction.
}
```

### Expression-oriented code

Prefer assigning from expressions instead of mutating a variable across branches. Use implicit tail returns for the final expression in a block when it improves clarity.

```rust
let status = if active {
    "running"
} else {
    "idle"
};

let config = {
    let raw = std::fs::read_to_string(path)?;
    parse(&raw)?
};
```

### Flat control flow

Use `?` for error propagation and combinators for simple `Option` or `Result` transformations. Avoid deeply nested `match` blocks when a flat expression communicates the path better.

```rust
fn role(id: UserId) -> Result<Role, Error> {
    let user = fetch(id)?;
    user.role.ok_or(Error::NoRole)
}
```

### Pattern matching and destructuring

Use `if let` or `while let` when only one case matters. Use `match` when multiple cases are meaningful or exhaustive handling is clearer.

```rust
if let Some(user) = user {
    println!("Hello, {}", user.name);
}

if let [first, second, ..] = items.as_slice() {
    println!("First: {first}, Second: {second}");
}
```

### Iterators

Prefer iterator chains when they express collection transformations declaratively without hiding important control flow.

```rust
let even_squares: Vec<i32> = numbers
    .into_iter()
    .filter(|value| value % 2 == 0)
    .map(|value| value * value)
    .collect();
```

Use an explicit loop when it is easier to debug, involves complex branching, or better communicates side effects.

### Functional Rust

Prefer a functional core with imperative boundaries. Use Rust's ownership model to keep transformations predictable, but do not optimize for a functional-looking style when it makes ownership, allocation, or branching harder to read.

- Keep domain transformations pure when practical: inputs in, values out, no hidden I/O, global mutation, or ambient state.
- Prefer immutable bindings by default. Use `mut` when stepwise construction, ownership movement, performance, or readability makes mutation the clearer choice.
- Prefer iterator adapters for straightforward collection transformations, especially `map`, `filter`, `filter_map`, `flat_map`, `fold`, `try_fold`, `any`, `all`, and `find`.
- Prefer `Option` and `Result` combinators for small linear transformations. Use `match`, `if let`, or `let ... else` when branching has meaningful domain cases, needs named steps, or carries non-trivial error context.
- Avoid cloning, heap allocation, boxing, or collecting intermediate vectors just to preserve a chain-based style.
- Break long chains with named intermediate values when that improves debuggability, exposes domain meaning, or avoids confusing borrow lifetimes.
- Use explicit loops for side effects, complex early exits, async/event loops, state machines, and code that becomes clearer imperatively.
- Keep closure captures narrow. Prefer a small named function when a closure grows enough to hide intent.

### Typestate

Use typestate for APIs where only some operations are valid after specific transitions. Model state transitions by consuming `self` when that makes invalid call sequences fail at compile time.

```rust
struct Closed;
struct Opened {
    handle: std::fs::File,
}

struct File<State> {
    state: State,
}

impl File<Closed> {
    fn open(self) -> File<Opened> {
        File {
            state: Opened { /* handle */ },
        }
    }
}

impl File<Opened> {
    fn write(&mut self, data: &[u8]) {
        // Only available after opening.
    }
}
```

### API boundary conversions

Use standard conversion traits to make call sites clean without sacrificing explicit boundaries.

- Implement `From<T>` when conversion is infallible and obvious.
- Use `TryFrom<T>` when conversion can fail.
- Accept `impl Into<T>` when callers should pass multiple owned input types.
- Accept `impl AsRef<T>` for borrowed views such as paths or strings when appropriate.

```rust
fn greet(name: impl Into<String>) {
    let name = name.into();
    println!("Hello, {name}!");
}
```

### Tooling-enforced consistency

Use `rustfmt` for formatting and `clippy` for idiom, readability, and correctness suggestions. Treat tooling feedback as the default unless a project-specific constraint justifies a different choice.
