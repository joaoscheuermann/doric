// The layout chunk's interface (openui-diagrams.md F6): types only, always
// imported with `import type`, so the chunk and the renderer chunk share no
// module.

/**
 * The input of the layout chunk: drawn parts as keyed sizes, no labels, ids
 * or colors. Keys (toLayoutGraph): node i of the model is `n<i>`, group i
 * `g<i>`, edge i `e<i>`; unique across nodes, groups and edges.
 */
export interface LayoutGraph {
  /** `layered` when absent. `mrtree` takes no groups, and its edges form one tree. */
  readonly algorithm?: 'layered' | 'mrtree';
  /** The drawing puts markers on edge ends (entity diagrams): `layered` adds the marker options. */
  readonly markerSpacing?: true;
  /**
   * Edges may carry end labels (class diagrams, with or without counts written): a `right`
   * graph is laid out transposed.
   */
  readonly transposeRight?: true;
  readonly direction: 'down' | 'right';
  /**
   * Every group's inner padding in px: `top` above its children (the group
   * label's line height plus the group padding), `side` on the other three
   * sides.
   */
  readonly groupPadding: { readonly top: number; readonly side: number };
  readonly nodes: readonly {
    readonly key: string;
    readonly width: number;
    readonly height: number;
    /** The key of the group that holds the node. */
    readonly group?: string;
  }[];
  /** In any order; the parents form a forest. */
  readonly groups: readonly {
    readonly key: string;
    /** The key of the enclosing group. */
    readonly parent?: string;
    readonly minWidth: number;
  }[];
  readonly edges: readonly {
    readonly key: string;
    /** Node keys. */
    readonly from: string;
    readonly to: string;
    readonly label?: { readonly width: number; readonly height: number };
    /** Placed by ELK at the source end (`TAIL`) and the target end (`HEAD`); `layered` only, no groups. */
    readonly tailLabel?: { readonly width: number; readonly height: number };
    readonly headLabel?: { readonly width: number; readonly height: number };
  }[];
}
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface Point {
  readonly x: number;
  readonly y: number;
}
/** One coordinate system (root); keyed by the graph's keys, every key present. */
export interface LayoutResult {
  readonly width: number;
  readonly height: number;
  readonly nodes: Readonly<Record<string, Box>>;
  readonly groups: Readonly<Record<string, Box>>;
  /**
   * `points`: start, bends, end, at least 2, with no two equal in a row. `label`, `tailLabel`
   * and `headLabel` are present exactly when the graph's edge had them (in result coordinates,
   * already swapped back for a transposed layout).
   */
  readonly edges: Readonly<
    Record<
      string,
      {
        readonly points: readonly Point[];
        readonly label?: Box;
        readonly tailLabel?: Box;
        readonly headLabel?: Box;
      }
    >
  >;
}
