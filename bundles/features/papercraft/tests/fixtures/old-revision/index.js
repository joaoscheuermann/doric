var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// papercraft-entry:papercraft:entry
import { Component, createElement } from "react";
import { createRoot } from "react-dom/client";

// papercraft-source:src/Overlay.stories.tsx
var Overlay_stories_exports = {};
__export(Overlay_stories_exports, {
  Open: () => Open,
  default: () => Overlay_stories_default
});
import { createPortal } from "react-dom";

// papercraft-jsx:papercraft-jsx/jsx-dev-runtime
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var PREFIX = "papercraft-source:";
function jsxDEV(type, props, key, isStatic, source) {
  let next = props;
  if (typeof type === "string" && source != null && typeof source.fileName === "string" && props != null && props["data-papercraft-source"] === void 0) {
    const file = source.fileName.startsWith(PREFIX) ? source.fileName.slice(PREFIX.length) : source.fileName;
    next = { ...props, "data-papercraft-source": file + ":" + source.lineNumber };
  }
  return isStatic ? jsxs(type, next, key) : jsx(type, next, key);
}

// papercraft-source:src/Overlay.stories.tsx
var Overlay_stories_default = { parameters: { layout: "padded" } };
var Open = {
  render: (_args, context) => /* @__PURE__ */ jsxDEV("div", { id: "anchor", children: createPortal(/* @__PURE__ */ jsxDEV("div", { id: "overlay", children: "open" }, void 0, false, {
    fileName: "papercraft-source:src/Overlay.stories.tsx",
    lineNumber: 6,
    columnNumber: 21
  }), context.papercraft.portalContainer) }, void 0, false, {
    fileName: "papercraft-source:src/Overlay.stories.tsx",
    lineNumber: 5,
    columnNumber: 5
  })
};

// papercraft-entry:papercraft:entry
var Harness = void 0;
var EXPORT_NAME = "Open";
var STORIES_FILE = true;
var STORIES = ["Open"];
var list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var merge = (...parts) => {
  const out = {};
  for (const part of parts) if (isObject(part)) Object.assign(out, part);
  return out;
};
var mergeParameters = (...parts) => {
  const out = {};
  for (const part of parts) {
    if (!isObject(part)) continue;
    for (const [key, value] of Object.entries(part)) {
      out[key] = isObject(value) && isObject(out[key]) ? { ...out[key], ...value } : value;
    }
  }
  return out;
};
var LAYOUTS = ["centered", "padded", "fullscreen"];
var layoutOf = (parameters) => isObject(parameters) && LAYOUTS.includes(parameters.layout) ? parameters.layout : "centered";
var META_KEYS = ["component", "render", "title", "args", "argTypes", "decorators", "parameters"];
var isMeta = (value) => isObject(value) && !("$$typeof" in value) && META_KEYS.some((key) => key in value);
var storyName = (name) => name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase());
var harness = (() => {
  if (Harness === void 0) return { decorators: [], parameters: {}, args: {}, argTypes: {} };
  const preview = isObject(Harness.default) ? Harness.default : {};
  return {
    decorators: [...list(preview.decorators), ...list(Harness.decorators)],
    parameters: mergeParameters(preview.parameters, Harness.parameters),
    args: merge(preview.args, Harness.args),
    argTypes: merge(preview.argTypes, Harness.argTypes)
  };
})();
var describe = () => {
  const meta = Overlay_stories_default;
  if (!STORIES_FILE && !isMeta(meta)) {
    const Preview = Overlay_stories_exports[EXPORT_NAME];
    return {
      id: EXPORT_NAME,
      name: EXPORT_NAME,
      title: void 0,
      render: () => createElement(Preview),
      args: { ...harness.args },
      argTypes: harness.argTypes,
      parameters: harness.parameters,
      decorators: harness.decorators
    };
  }
  const metaObject = isObject(meta) ? meta : {};
  const exportName = EXPORT_NAME !== "default" ? EXPORT_NAME : STORIES[0];
  if (exportName === void 0) throw new Error("The stories file exports no story.");
  const raw = Overlay_stories_exports[exportName];
  const story = typeof raw === "function" ? { render: raw, name: raw.storyName, args: raw.args, argTypes: raw.argTypes, parameters: raw.parameters, decorators: raw.decorators } : isObject(raw) ? raw : {};
  const component = metaObject.component;
  const render = story.render ?? metaObject.render ?? (component ? (args) => createElement(component, args) : void 0);
  if (typeof render !== "function") {
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
    decorators: [...list(story.decorators), ...list(metaObject.decorators), ...harness.decorators]
  };
};
var decorate = (spec) => {
  function PapercraftStory({ context }) {
    return spec.render(context.args, context);
  }
  let layer = (context) => createElement(PapercraftStory, { context });
  for (const decorator of spec.decorators) {
    if (typeof decorator !== "function") continue;
    const inner = layer;
    let current;
    const Story = (update) => {
      const changes = isObject(update) ? update : {};
      const next = changes.args || changes.globals || changes.parameters ? {
        ...current,
        args: merge(current.args, changes.args),
        globals: merge(current.globals, changes.globals),
        parameters: mergeParameters(current.parameters, changes.parameters)
      } : current;
      return inner(next);
    };
    layer = (context) => {
      current = context;
      return decorator(Story, context);
    };
  }
  return layer;
};
var PreviewBoundary = class extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, error: void 0 };
  }
  static getDerivedStateFromError(error) {
    return { failed: true, error };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const error = this.state.error;
    return createElement(
      "pre",
      {
        "data-papercraft-error": "",
        style: {
          margin: 0,
          padding: "12px",
          whiteSpace: "pre-wrap",
          color: "#b91c1c",
          font: "12px/1.5 ui-monospace, monospace"
        }
      },
      String(error && error.stack || error)
    );
  }
};
var container = (attribute, theme) => {
  const element = document.createElement("div");
  element.setAttribute(attribute, "");
  element.setAttribute("data-papercraft-theme", theme);
  element.style.display = "contents";
  return element;
};
function mount(root, options) {
  const theme = options && options.theme === "dark" ? "dark" : "light";
  const app = container("data-papercraft-root", theme);
  const portalContainer = container("data-papercraft-portal", theme);
  if (theme === "dark") portalContainer.className = "dark";
  root.append(app, portalContainer);
  let prepared;
  const prepare = () => {
    if (prepared !== void 0) return prepared;
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
      viewMode: "story",
      loaded: {},
      papercraft
    };
    prepared = { render: decorate(spec), context };
    return prepared;
  };
  function PapercraftPreview() {
    const { render, context } = prepare();
    return render(context);
  }
  let layout = "centered";
  try {
    layout = layoutOf(prepare().context.parameters);
  } catch {
  }
  root.setAttribute("data-papercraft-layout", layout);
  const report = (what) => (error, info) => {
    const stack = info && info.componentStack;
    console.error("papercraft: " + what + " in " + import.meta.url, error, ...stack ? [stack] : []);
  };
  const reactRoot = createRoot(app, {
    onRecoverableError: report("a render error React recovered from"),
    onCaughtError: report("a render error"),
    onUncaughtError: report("an uncaught render error")
  });
  reactRoot.render(
    createElement(
      "div",
      {
        className: theme === "dark" ? "dark" : void 0,
        "data-papercraft-theme": theme,
        style: { display: "contents" }
      },
      createElement(PreviewBoundary, null, createElement(PapercraftPreview))
    )
  );
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    queueMicrotask(() => {
      reactRoot.unmount();
      app.remove();
      portalContainer.remove();
      root.removeAttribute("data-papercraft-layout");
    });
  };
}
export {
  mount
};
