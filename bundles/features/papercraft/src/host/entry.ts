// The module a component preview compiles to: `mount(root, { theme })` around
// the previewed source, the Project's harness decorators and, for a CSF
// stories file, the chosen story.
//
// `mount` puts two containers in the root it is given (the surface's content
// element, inside the preview's shadow root): the React root's own, and a
// portal container beside it. Portaled overlays (Radix Dialog, Popover,
// Tooltip…) that are handed the portal container render inside the shadow
// root — in the zoomed canvas, under the preview's sheet, where comments can
// anchor to them — instead of in `document.body`. Radix has no global
// default for a portal's container, and the preview assumes nothing of the
// Project's components, so the container is handed to the decorators and
// stories as `context.papercraft.portalContainer` (also
// `context.parameters.papercraft.portalContainer`), and the Project's
// harness passes it on to its components (Doric's, to `desktop/ui`'s
// `PortalContainerProvider`).
//
// CSF (Storybook's Component Story Format, v3 objects and v2 functions): the
// story renders `story.render(args, context)`, else `meta.render`, else
// `<meta.component {...args} />`, with `args = { ...preview.args,
// ...meta.args, ...story.args }` (shallow) and `parameters` merged one level
// deep in the same order. Decorators apply in Storybook's order — the
// story's, then the meta's, then the harness's, the first innermost — and
// each receives `(Story, context)`, where `Story` renders as `<Story />` or
// `Story({ args })`. `argTypes` actions are not synthesized: an `on*`
// handler the args do not give is `undefined`. A plain component (not CSF)
// renders with no props, under the harness's decorators.
//
// `mount` also states the story's Storybook layout on the root as
// `data-papercraft-layout`: the merged `parameters.layout` when it is
// `centered`, `padded` or `fullscreen`, else `centered`, papercraft's
// default. The surface sizes the preview by it: `centered` hugs the content,
// the other two lay it out at the canvas's width. Storybook's padding is not
// reproduced, since the canvas already surrounds the preview.

/** The virtual module of the previewed source. */
export const SOURCE_ID = 'papercraft:source';

/** The virtual module of the Project's harness. */
export const HARNESS_ID = 'papercraft:harness';

/** Whether a path names a CSF stories file. */
export const isStoriesFile = (path: string): boolean =>
  /\.stories\.(?:tsx|ts|jsx|js|mjs|mts)$/.test(path);

/** Exports that are never stories in a CSF file. */
const NOT_STORIES = new Set(['default', '__namedExportsOrder']);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The named exports of a module in the order its source declares them —
 * the order Storybook lists stories in. Names the text does not reveal keep
 * the order they were given in, after the others.
 */
export const storyOrder = (
  source: string,
  exports: readonly string[],
): readonly string[] => {
  const listed = [...source.matchAll(/export\s*\{([^}]*)\}/g)];

  const positionOf = (name: string): number => {
    const escaped = escapeRegExp(name);
    const declared = new RegExp(
      `export\\s+(?:async\\s+)?(?:const|let|var|function\\*?|class)\\s+${escaped}\\b`,
    ).exec(source);

    if (declared !== null) return declared.index;

    for (const match of listed) {
      const inner = new RegExp(`(?:^|[\\s,])(?:\\w+\\s+as\\s+)?${escaped}\\b`);

      if (inner.test(match[1] ?? '')) return match.index;
    }

    return Number.POSITIVE_INFINITY;
  };

  return exports
    .filter((name) => !NOT_STORIES.has(name))
    .map((name, index) => ({ name, index, at: positionOf(name) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ name }) => name);
};

/** What the entry module mounts. */
export interface EntrySpec {
  /** The export to mount (`default` lets a CSF file pick its first story). */
  readonly exportName: string;
  /** Whether the source is a stories file by name. */
  readonly storiesFile: boolean;
  /** The source's named exports in source order, minus `default`. */
  readonly stories: readonly string[];
  /** Whether the harness is bundled. */
  readonly harness: boolean;
}

const RUNTIME = `
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const merge = (...parts) => {
  const out = {};
  for (const part of parts) if (isObject(part)) Object.assign(out, part);
  return out;
};
const mergeParameters = (...parts) => {
  const out = {};
  for (const part of parts) {
    if (!isObject(part)) continue;
    for (const [key, value] of Object.entries(part)) {
      out[key] = isObject(value) && isObject(out[key]) ? { ...out[key], ...value } : value;
    }
  }
  return out;
};
// Storybook's layouts. The surface sizes the preview by the one a story's
// merged parameters name; papercraft's default is centered, so a preview
// hugs its content.
const LAYOUTS = ['centered', 'padded', 'fullscreen'];
const layoutOf = (parameters) =>
  isObject(parameters) && LAYOUTS.includes(parameters.layout) ? parameters.layout : 'centered';
const META_KEYS = ['component', 'render', 'title', 'args', 'argTypes', 'decorators', 'parameters'];
const isMeta = (value) =>
  isObject(value) && !('$$typeof' in value) && META_KEYS.some((key) => key in value);
const storyName = (name) =>
  name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (first) => first.toUpperCase());

const harness = (() => {
  if (Harness === undefined) return { decorators: [], parameters: {}, args: {}, argTypes: {} };
  const preview = isObject(Harness.default) ? Harness.default : {};
  return {
    decorators: [...list(preview.decorators), ...list(Harness.decorators)],
    parameters: mergeParameters(preview.parameters, Harness.parameters),
    args: merge(preview.args, Harness.args),
    argTypes: merge(preview.argTypes, Harness.argTypes),
  };
})();

const describe = () => {
  const meta = Source.default;
  if (!STORIES_FILE && !isMeta(meta)) {
    const Preview = Source[EXPORT_NAME];
    return {
      id: EXPORT_NAME,
      name: EXPORT_NAME,
      title: undefined,
      render: () => createElement(Preview),
      args: { ...harness.args },
      argTypes: harness.argTypes,
      parameters: harness.parameters,
      decorators: harness.decorators,
    };
  }
  const metaObject = isObject(meta) ? meta : {};
  const exportName = EXPORT_NAME !== 'default' ? EXPORT_NAME : STORIES[0];
  if (exportName === undefined) throw new Error('The stories file exports no story.');
  const raw = Source[exportName];
  const story =
    typeof raw === 'function'
      ? { render: raw, name: raw.storyName, args: raw.args, argTypes: raw.argTypes, parameters: raw.parameters, decorators: raw.decorators }
      : isObject(raw)
        ? raw
        : {};
  const component = metaObject.component;
  const render =
    story.render ?? metaObject.render ?? (component ? (args) => createElement(component, args) : undefined);
  if (typeof render !== 'function') {
    throw new Error('The story "' + exportName + '" has no render, and its meta names no component.');
  }
  return {
    id: exportName,
    name: story.name ?? storyName(exportName),
    title: metaObject.title,
    render,
    args: merge(harness.args, metaObject.args, story.args),
    argTypes: merge(harness.argTypes, metaObject.argTypes, story.argTypes),
    parameters: mergeParameters(harness.parameters, metaObject.parameters, story.parameters),
    decorators: [...list(story.decorators), ...list(metaObject.decorators), ...harness.decorators],
  };
};

// The decorators, first innermost. Each layer's \`Story\` is one stable
// function, so a decorator that renders \`<Story />\` keeps its subtree's
// state across re-renders.
const decorate = (spec) => {
  function PapercraftStory({ context }) {
    return spec.render(context.args, context);
  }
  let layer = (context) => createElement(PapercraftStory, { context });
  for (const decorator of spec.decorators) {
    if (typeof decorator !== 'function') continue;
    const inner = layer;
    let current;
    const Story = (update) => {
      const changes = isObject(update) ? update : {};
      const next =
        changes.args || changes.globals || changes.parameters
          ? {
              ...current,
              args: merge(current.args, changes.args),
              globals: merge(current.globals, changes.globals),
              parameters: mergeParameters(current.parameters, changes.parameters),
            }
          : current;
      return inner(next);
    };
    layer = (context) => {
      current = context;
      return decorator(Story, context);
    };
  }
  return layer;
};

class PreviewBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, error: undefined };
  }
  static getDerivedStateFromError(error) {
    return { failed: true, error };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const error = this.state.error;
    return createElement(
      'pre',
      {
        'data-papercraft-error': '',
        style: {
          margin: 0,
          padding: '12px',
          whiteSpace: 'pre-wrap',
          color: '#b91c1c',
          font: '12px/1.5 ui-monospace, monospace',
        },
      },
      String((error && error.stack) || error),
    );
  }
}

const container = (attribute, theme) => {
  const element = document.createElement('div');
  element.setAttribute(attribute, '');
  element.setAttribute('data-papercraft-theme', theme);
  element.style.display = 'contents';
  return element;
};

export function mount(root, options) {
  const theme = options && options.theme === 'dark' ? 'dark' : 'light';
  const app = container('data-papercraft-root', theme);
  const portalContainer = container('data-papercraft-portal', theme);
  if (theme === 'dark') portalContainer.className = 'dark';
  root.append(app, portalContainer);

  let prepared;
  const prepare = () => {
    if (prepared !== undefined) return prepared;
    const spec = describe();
    const papercraft = { portalContainer, theme, root };
    const context = {
      id: spec.id,
      name: spec.name,
      story: spec.name,
      title: spec.title,
      kind: spec.title,
      args: spec.args,
      initialArgs: spec.args,
      argTypes: spec.argTypes,
      parameters: { ...spec.parameters, papercraft: { ...spec.parameters.papercraft, ...papercraft } },
      globals: { theme },
      viewMode: 'story',
      loaded: {},
      papercraft,
    };
    prepared = { render: decorate(spec), context };
    return prepared;
  };

  function PapercraftPreview() {
    const { render, context } = prepare();
    return render(context);
  }

  let layout = 'centered';
  try {
    layout = layoutOf(prepare().context.parameters);
  } catch {
    // A story that cannot be described renders its error in the boundary.
  }
  root.setAttribute('data-papercraft-layout', layout);

  const reactRoot = createRoot(app);
  reactRoot.render(
    createElement(
      'div',
      {
        className: theme === 'dark' ? 'dark' : undefined,
        'data-papercraft-theme': theme,
        style: { display: 'contents' },
      },
      createElement(PreviewBoundary, null, createElement(PapercraftPreview)),
    ),
  );
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    // Deferred: the surface unmounts from inside React's own commit.
    queueMicrotask(() => {
      reactRoot.unmount();
      app.remove();
      portalContainer.remove();
      root.removeAttribute('data-papercraft-layout');
    });
  };
}
`;

/** The module the node imports: the chosen export, mounted by `mount`. */
export const entryModule = (spec: EntrySpec): string =>
  [
    "import { Component, createElement } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import * as Source from ${JSON.stringify(SOURCE_ID)};`,
    spec.harness
      ? `import * as Harness from ${JSON.stringify(HARNESS_ID)};`
      : 'const Harness = undefined;',
    '',
    `const EXPORT_NAME = ${JSON.stringify(spec.exportName)};`,
    `const STORIES_FILE = ${JSON.stringify(spec.storiesFile)};`,
    `const STORIES = ${JSON.stringify(spec.stories)};`,
    RUNTIME,
  ].join('\n');
