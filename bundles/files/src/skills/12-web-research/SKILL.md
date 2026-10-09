---
name: web-research
description: 'Finds and inspects current or externally hosted information through a search-open-find workflow. Use when the goal depends on facts or documentation not present in the workspace or supplied context.'
allowed-tools:
  - web
---

# Web Research

## Purpose

Obtain externally hosted evidence through a deliberate sequence of discovery, page inspection, and source comparison.

## Use this skill when

- current facts, official documentation, public specifications, or external pages are required;
- the user asks to search, verify, compare sources, or open a URL;
- local files and supplied context do not contain the needed information.

## Do not use this skill when

- the answer should be derived exclusively from supplied files or local workspace content;
- a search snippet alone would be treated as final evidence;
- the requested action concerns local files rather than HTTP(S) content.

## Procedure

1. Define the exact fact, document, or terminology that must be found.
2. Use `search` with a focused query. Prefer official or primary sources when the objective permits.
3. Open the most relevant pages and inspect their extracted text. Do not rely only on titles or snippets.
4. Use `find_in_page` for exact terms, version numbers, clauses, or headings inside long pages.
5. Check dates, scope, version, and whether the source directly supports the claim. Compare independent sources when a material fact is uncertain or disputed.
6. Preserve the source title, URL, and the specific supporting passage or finding. Distinguish source statements from inference.
7. If results or page text are truncated, narrow the query, reduce the page range through targeted finding, or inspect another source.

## Completion

The required external evidence is identified from inspected pages, its source and scope are preserved, and remaining uncertainty is explicit.
