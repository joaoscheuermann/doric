# @monodon/rust

`@monodon/rust` is an Nx plugin that integrates Cargo and Rust projects into the Nx workspace. It provides generators to scaffold binary and library crates and executors that wrap cargo commands with Nx caching.

## Generators

- **Library:** `npx nx generate @monodon/rust:library <name>` (Use `--napi` for Node bindings)
- **Binary:** `npx nx generate @monodon/rust:binary <name>`

## Standard Executors

| Target  | Executor              | Purpose                                              |
| ------- | --------------------- | ---------------------------------------------------- |
| `build` | `@monodon/rust:check` | Compile crate (`check` skips codegen, faster for CI) |
| `test`  | `@monodon/rust:test`  | Run `cargo test`                                     |
| `lint`  | `@monodon/rust:lint`  | Run `cargo clippy`                                   |
| `run`   | `@monodon/rust:run`   | Run `cargo run` (binaries only)                      |

Exception: a Rust crate that is also a bundle (tagged `type:bundle`) names its
`@monodon/rust:check` target `check`, builds its executable with a `compile`
target (`@monodon/rust:build`), and makes `build` the bundle-CLI build, which
depends on `compile` and `bundle:build`, as
[`bundles/foundation/sqlite/project.json`](../../../../bundles/foundation/sqlite/project.json)
does. Such a bundle may hold several crates in one Nx project: `sqlite` has
the library `engine/` (`doric-sqlite`) and the binary package `storage/`
(`doric-storage`); `check` and `compile` name the binary's package
(`"package": "doric-storage"`), and `test`, `lint` and `format-check` are
`nx:run-commands` targets passing `-p` for every crate. `clean` is
`cargo clean --target-dir dist/target/doric-sqlite` with `cwd`
`{workspaceRoot}`: the project directory has no `Cargo.toml`, so cargo run
there would walk up to the workspace. The template below is
for every other crate.

## Workspace Conventions

- A workspace `Cargo.toml` at the repo root with `resolver = '2'` is standard.
- New crates must be listed in `[workspace].members`.
- Build artifacts are redirected under `dist/target/<project-name>` via `target-dir` to keep the source tree clean.

## Canonical project.json Template

```json
{
  "name": "<crate-name>",
  "projectType": "library",
  "sourceRoot": "<project-root>/src",
  "targets": {
    "build": {
      "executor": "@monodon/rust:check",
      "outputs": ["{options.target-dir}"],
      "options": { "target-dir": "dist/target/<crate-name>" }
    },
    "test": {
      "cache": true,
      "executor": "@monodon/rust:test",
      "outputs": ["{options.target-dir}"],
      "options": { "target-dir": "dist/target/<crate-name>" },
      "configurations": { "production": { "release": true } }
    },
    "lint": {
      "cache": true,
      "executor": "@monodon/rust:lint",
      "outputs": ["{options.target-dir}"],
      "options": { "target-dir": "dist/target/<crate-name>" }
    },
    "clean": {
      "executor": "nx:run-commands",
      "options": { "command": "cargo clean", "cwd": "{projectRoot}" }
    }
  }
}
```
