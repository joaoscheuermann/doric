import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Mustache, { type RenderOptions, type TemplateSpans } from 'mustache';

/**
 * The values a template renders, by name. A name the view lacks renders as
 * the empty string; a `#` section on it renders nothing; a `^` section on it
 * renders its body.
 */
export type TemplateView = Readonly<Record<string, unknown>>;

/** The tag types that cite a name of the view. */
const citing = new Set(['name', '&', '#', '^']);

const checkSpans = (
  spans: TemplateSpans,
  names: readonly string[],
  file: string,
): void => {
  for (const span of spans) {
    const [type, value] = span;

    if (type === '>') {
      throw new Error(
        `Template "${file}" includes partial "${value}"; partials are not supported.`,
      );
    }

    if (citing.has(type) && !names.includes(value)) {
      throw new Error(`Template "${file}" cites undeclared name "${value}".`);
    }

    if (Array.isArray(span[4])) {
      checkSpans(span[4], names, file);
    }
  }
};

/**
 * Checks a template's text against the names it may cite and returns the text
 * to render.
 *
 * Accepts the template `source`, the `names` it may cite, and the `file` used
 * in error messages. Returns `source` with exactly one trailing "\n" removed;
 * text without a trailing "\n" comes back unchanged, and any further trailing
 * newlines stay.
 *
 * Every `name`, `&` (also `{{{…}}}`), `#` and `^` tag, at any section depth,
 * must be one of `names`. Dotted names such as `a.b` and the implicit `.` are
 * compared whole. Comments (`!`) and delimiter changes (`=`) are allowed.
 *
 * Throws an Error whose message names `file` and the cause:
 * - `Template "<file>" cites undeclared name "<name>".` for a name outside `names`;
 * - `Template "<file>" includes partial "<name>"; partials are not supported.` for a `>` tag;
 * - `Template "<file>": <parse error message>` when mustache cannot parse the
 *   text (an unclosed tag, an unclosed or unopened section).
 *
 * Has no other effect: no I/O, and mustache's global state (`escape`, `tags`)
 * is left unchanged.
 */
export const checkTemplate = (
  source: string,
  names: readonly string[],
  file: string,
): string => {
  const template = source.endsWith('\n') ? source.slice(0, -1) : source;
  let spans: TemplateSpans;

  try {
    spans = Mustache.parse(template);
  } catch (error) {
    throw new Error(
      `Template "${file}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  checkSpans(spans, names, file);

  return template;
};

/**
 * Reads the template at `url` synchronously as UTF-8 and returns
 * `checkTemplate(text, names, fileURLToPath(url))`.
 *
 * Fails with the fs error when the file cannot be read (ENOENT when it is
 * missing), or with `checkTemplate`'s Error. A module that calls this at import
 * time therefore fails to import, and the bundle part holding it is
 * quarantined with `invalid_part`. It never returns a partial or
 * unchecked template.
 */
export const loadTemplate = (url: URL, names: readonly string[]): string =>
  checkTemplate(readFileSync(url, 'utf8'), names, fileURLToPath(url));

/** Renders values as written: prompts are read by a model, not a browser. */
const options: RenderOptions = { escape: String };

/**
 * Renders `template` with `view` through mustache 4.2.
 *
 * Values render as `String(value)` with no HTML escaping; the escaping is a
 * per-call `RenderOptions.escape`, never an assignment to `Mustache.escape`.
 * Partials are not supplied, so a `>` tag renders empty. A name absent from
 * `view` renders empty and its `#` section renders nothing.
 *
 * Returns the rendered string. Throws mustache's parse Error for a template
 * it cannot parse; a template returned by `checkTemplate` or `loadTemplate`
 * parses. Global mustache state is left unchanged.
 */
export const render = (template: string, view: TemplateView): string =>
  Mustache.render(template, view, undefined, options);

/** `text` without one "\n" at its start and one at its end, each when present. */
const block = (text: string): string => text.replace(/^\n|\n$/gu, '');

/** The source of the first `#name` section of `spans`, from its opening tag through its closing tag. */
const sectionSource = (
  template: string,
  spans: TemplateSpans,
  name: string,
): string | undefined => {
  for (const span of spans) {
    if (span.length !== 6) continue;
    const [type, value, start, , children, closing] = span;

    const found =
      type === '#' && value === name
        ? template.slice(start, template.indexOf('}}', closing) + 2)
        : sectionSource(template, children, name);
    if (found !== undefined) return found;
  }

  return undefined;
};

/**
 * Renders the first `#name` section of `template` (depth-first, source order) with `items` as its value,
 * exactly as the whole template renders that section, and returns it as a block: without one "\n" at its
 * start and one at its end, each only when present. `[]` gives ''.
 * Exact when the section's opening and closing tags each stand alone on their line and every item defines
 * every name the section cites (nothing falls through to an enclosing view). No HTML escaping, as `render`.
 * Throws Error `Template has no section "<name>".` when there is none. Global mustache state unchanged.
 */
export const renderSection = (
  template: string,
  name: string,
  items: readonly TemplateView[],
): string => {
  const source = sectionSource(template, Mustache.parse(template), name);

  if (source === undefined) {
    throw new Error(`Template has no section "${name}".`);
  }

  return block(render(source, { [name]: items }));
};

/** `render(template, view)` as a block (one leading and one trailing "\n" removed, each when present):
 * the text of a template whose every rendered line ends with "\n". */
export const renderBlock = (template: string, view: TemplateView): string =>
  block(render(template, view));
