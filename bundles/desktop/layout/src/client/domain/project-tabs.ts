export interface ProjectTabs {
  readonly order: readonly string[];
  readonly paths: Readonly<Record<string, string>>;
  readonly homePath: '/' | '/projects';
}

export const emptyProjectTabs: ProjectTabs = {
  order: [],
  paths: {},
  homePath: '/',
};

export const projectIdFromPath = (path: string): string | undefined => {
  const match = /^\/projects\/([^/]+)(?:\/threads\/([^/]+))?$/.exec(path);
  if (match === null) return undefined;
  try {
    if (match[2]) decodeURIComponent(match[2]);
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
};

export const rememberPath = (state: ProjectTabs, path: string): ProjectTabs => {
  if (path === '/' || path === '/projects') return { ...state, homePath: path };
  const id = projectIdFromPath(path);
  if (id === undefined) return state;
  return {
    ...state,
    order: state.order.includes(id) ? state.order : [...state.order, id],
    paths: { ...state.paths, [id]: path },
  };
};

export const closeProjectTab = (state: ProjectTabs, id: string): ProjectTabs =>
  closeProjectTabs(state, [id]);

export const closeProjectTabs = (
  state: ProjectTabs,
  ids: readonly string[],
): ProjectTabs => {
  const closed = new Set(ids);
  return {
    ...state,
    order: state.order.filter((id) => !closed.has(id)),
    paths: Object.fromEntries(
      Object.entries(state.paths).filter(([id]) => !closed.has(id)),
    ),
  };
};

export const reconcileProjectTabs = (
  state: ProjectTabs,
  ids: ReadonlySet<string>,
): ProjectTabs => ({
  ...state,
  order: state.order.filter((id) => ids.has(id)),
  paths: Object.fromEntries(
    Object.entries(state.paths).filter(
      ([id, path]) => ids.has(id) && projectIdFromPath(path) === id,
    ),
  ),
});

export const parseProjectTabs = (raw: string | null): ProjectTabs => {
  if (raw === null) return emptyProjectTabs;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return emptyProjectTabs;
    const input = value as Record<string, unknown>;
    const paths =
      typeof input.paths === 'object' && input.paths !== null
        ? (input.paths as Record<string, unknown>)
        : {};
    const order = Array.isArray(input.order)
      ? [
          ...new Set(
            input.order.filter((id): id is string => typeof id === 'string'),
          ),
        ]
      : [];
    return {
      homePath: input.homePath === '/projects' ? '/projects' : '/',
      order: order.filter(
        (id) => projectIdFromPath(paths[id] as string) === id,
      ),
      paths: Object.fromEntries(
        Object.entries(paths).filter(
          ([id, path]) =>
            typeof path === 'string' && projectIdFromPath(path) === id,
        ),
      ) as Record<string, string>,
    };
  } catch {
    return emptyProjectTabs;
  }
};
