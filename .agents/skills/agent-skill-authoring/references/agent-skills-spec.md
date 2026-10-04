# Agent Skills Specification

This document details the strict structural and formatting requirements for creating an Agent Skill.

## 1. Directory Structure

A skill is a directory containing, at minimum, a `SKILL.md` file:

- `SKILL.md` (Required): Contains YAML frontmatter and markdown instructions. Should ideally be kept under 500 lines.
- `scripts/` (Optional): Executable code (Python, Bash, JS) that agents can run.
- `references/` (Optional): Additional markdown documentation loaded via progressive disclosure.
- `assets/` (Optional): Static resources like templates, diagrams, or schemas.

## 2. YAML Frontmatter Requirements

The `SKILL.md` must start with valid YAML frontmatter.

### `name` (Required)

- **Constraint:** 1-64 characters.
- **Format:** Lowercase alphanumeric (`a-z`, `0-9`) and hyphens (`-`) only.
- **Rules:** Cannot start/end with a hyphen, nor contain consecutive hyphens. Must match the parent directory name exactly.

### `description` (Required)

- **Constraint:** 1-1024 characters.
- **Content:** Describe what the skill does AND when an agent should use it. Use specific keywords to aid discoverability.

### Optional Fields

- `license`: Short string (e.g., `Apache-2.0` or `Proprietary`).
- `compatibility`: Used only if specific environment requirements exist (e.g., `Requires Python 3.14+`). Max 500 chars.
- `metadata`: Arbitrary key-value map for internal tracking (e.g., `author: org`, `version: "1.0"`).
- `allowed-tools`: Space-separated string of pre-approved tools (e.g., `Bash(jq:*) Read`).

## 3. Validation (Repository Invariant)

All skills must pass the reference library validation before being committed:
`skills-ref validate ./my-skill-name`
