import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createNodeSelection,
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  getComposedEventTarget,
  isDOMNode,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

type WidgetSelectionStore = {
  readonly isSelected: (key: NodeKey) => boolean;
  readonly subscribe: (key: NodeKey, listener: () => void) => () => void;
};

const selectionStores = new WeakMap<LexicalEditor, WidgetSelectionStore>();

/**
 * Reads the set of selected widget keys in the editor's current state: the
 * widgets among the selection's nodes, read once over those nodes rather than
 * once per widget. Every widget is a block decorator, for which Lexical's own
 * `isSelected` is exactly that membership — except a range selection that
 * rests collapsed between blocks, which selects none of them.
 */
const $selectedNodeKeys = (
  keys: ReadonlyMap<NodeKey, unknown>,
): Set<NodeKey> => {
  const selected = new Set<NodeKey>();
  const selection = $getSelection();
  if (selection === null) return selected;
  if (
    $isRangeSelection(selection) &&
    selection.anchor.type === 'element' &&
    selection.focus.type === 'element' &&
    selection.isCollapsed()
  )
    return selected;
  for (const node of selection.getNodes()) {
    const key = node.getKey();
    if (keys.has(key)) selected.add(key);
  }
  return selected;
};

/**
 * One selection observer per editor for all conversation widgets.
 *
 * A long transcript can mount hundreds of decorator widgets. Subscribing each
 * widget individually to `editor.registerUpdateListener` and running
 * `editor.read()` + `node.isSelected()` per widget makes every click or caret
 * move O(widgets * selectionNodes). Sharing one store per editor reads the
 * selection once per commit and notifies only the widgets whose selection state
 * actually flipped.
 */
export const getWidgetSelectionStore = (
  editor: LexicalEditor,
): WidgetSelectionStore => {
  const existing = selectionStores.get(editor);
  if (existing !== undefined) return existing;

  const listenersByKey = new Map<NodeKey, Set<() => void>>();
  let selectedKeys = new Set<NodeKey>();
  let unregisterUpdate: (() => void) | null = null;

  const syncFromEditor = (): Set<NodeKey> => {
    if (listenersByKey.size === 0) return new Set();
    return editor
      .getEditorState()
      .read(() => $selectedNodeKeys(listenersByKey));
  };

  const ensureListening = (): void => {
    if (unregisterUpdate !== null || listenersByKey.size === 0) return;
    selectedKeys = syncFromEditor();
    unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
      const nextSelected = editorState.read(() =>
        $selectedNodeKeys(listenersByKey),
      );
      const changed: NodeKey[] = [];
      for (const key of selectedKeys) {
        if (!nextSelected.has(key)) changed.push(key);
      }
      for (const key of nextSelected) {
        if (!selectedKeys.has(key)) changed.push(key);
      }
      selectedKeys = nextSelected;
      for (const key of changed) {
        const listeners = listenersByKey.get(key);
        if (listeners === undefined) continue;
        for (const listener of listeners) listener();
      }
    });
  };

  const stopListeningIfIdle = (): void => {
    if (listenersByKey.size > 0 || unregisterUpdate === null) return;
    unregisterUpdate();
    unregisterUpdate = null;
    selectedKeys.clear();
  };

  const store: WidgetSelectionStore = {
    isSelected: (key) => {
      if (unregisterUpdate !== null) return selectedKeys.has(key);
      return editor.getEditorState().read(() => {
        const node = $getNodeByKey(key);
        return node?.isSelected() === true;
      });
    },
    subscribe: (key, listener) => {
      let set = listenersByKey.get(key);
      const isNewKey = set === undefined;
      if (set === undefined) {
        set = new Set();
        listenersByKey.set(key, set);
      }
      set.add(listener);
      if (unregisterUpdate === null) {
        ensureListening();
      } else if (isNewKey) {
        const nowSelected = editor.getEditorState().read(() => {
          const node = $getNodeByKey(key);
          return node?.isSelected() === true;
        });
        if (nowSelected) selectedKeys.add(key);
        else selectedKeys.delete(key);
      }
      return () => {
        const current = listenersByKey.get(key);
        if (current !== undefined) {
          current.delete(listener);
          if (current.size === 0) {
            listenersByKey.delete(key);
            selectedKeys.delete(key);
          }
        }
        stopListeningIfIdle();
      };
    },
  };

  selectionStores.set(editor, store);
  return store;
};

/**
 * Shared node-selection hook backed by the per-editor `WidgetSelectionStore`.
 */
export function useSharedNodeSelection(
  nodeKey: NodeKey,
): [boolean, (selected: boolean) => void, () => void] {
  const [editor] = useLexicalComposerContext();
  const store = getWidgetSelectionStore(editor);

  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribe(nodeKey, onStoreChange),
    [store, nodeKey],
  );
  const getSnapshot = useCallback(
    () => store.isSelected(nodeKey),
    [store, nodeKey],
  );
  const isSelected = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setSelected = useCallback(
    (selected: boolean) => {
      editor.update(() => {
        let selection = $getSelection();
        if (!$isNodeSelection(selection)) {
          const node = selected ? null : $getNodeByKey(nodeKey);
          if (node !== null && !node.isSelected()) {
            return;
          }
          selection = $createNodeSelection();
          $setSelection(selection);
        }
        if ($isNodeSelection(selection)) {
          if (selected) {
            selection.add(nodeKey);
          } else {
            selection.delete(nodeKey);
          }
        }
      });
    },
    [editor, nodeKey],
  );

  const clearSelected = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isNodeSelection(selection)) {
        selection.clear();
      }
    });
  }, [editor]);

  return [isSelected, setSelected, clearSelected];
}

const clickRootByEditor = new WeakMap<
  LexicalEditor,
  {
    readonly elementsByKey: Map<NodeKey, HTMLElement>;
    readonly keyByElement: WeakMap<HTMLElement, NodeKey>;
    unregister: (() => void) | null;
  }
>();

const registerWidgetElement = (
  editor: LexicalEditor,
  nodeKey: NodeKey,
  element: HTMLElement,
): (() => void) => {
  let state = clickRootByEditor.get(editor);
  if (state === undefined) {
    state = {
      elementsByKey: new Map(),
      keyByElement: new WeakMap(),
      unregister: null,
    };
    clickRootByEditor.set(editor, state);
  }
  const currentState = state;
  currentState.elementsByKey.set(nodeKey, element);
  currentState.keyByElement.set(element, nodeKey);

  if (currentState.unregister === null) {
    currentState.unregister = editor.registerCommand(
      CLICK_COMMAND,
      (event) => {
        const target = getComposedEventTarget(event);
        if (!isDOMNode(target)) return false;
        let current: Node | null = target;
        while (current !== null) {
          if (current instanceof HTMLElement) {
            const matchedKey = currentState.keyByElement.get(current);
            if (matchedKey !== undefined) {
              event.preventDefault();
              const currentSelection = $getSelection();
              if ($isNodeSelection(currentSelection)) {
                if (!event.shiftKey) currentSelection.clear();
                currentSelection.add(matchedKey);
              } else {
                const nextSelection = $createNodeSelection();
                nextSelection.add(matchedKey);
                $setSelection(nextSelection);
              }
              return true;
            }
          }
          current = current.parentNode;
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }

  return () => {
    if (currentState.elementsByKey.get(nodeKey) === element) {
      currentState.elementsByKey.delete(nodeKey);
    }
    currentState.keyByElement.delete(element);
    if (
      currentState.elementsByKey.size === 0 &&
      currentState.unregister !== null
    ) {
      currentState.unregister();
      currentState.unregister = null;
    }
  };
};

type WidgetFocusProps = {
  /** The node the widget is built on: what the focus selects. */
  readonly nodeKey: NodeKey;
  /** The widget's parts, told whether the widget holds the caret. */
  readonly children: (focused: boolean) => ReactNode;
};

/**
 * A widget of the conversation focused as a unit.
 *
 * The caret never enters a widget — a thinking run, a tool call, an activity
 * summary is one stop — and its focus is the editor's node selection. The parts
 * draw that focus themselves, in their own hover style, so a focused widget
 * looks the way it does under the pointer and wears no frame of its own. A
 * click takes that focus as a unit (with Shift it adds the widget to the
 * selection instead), while the controls inside keep their own behaviour: the
 * chevron still opens and closes. The focus is editor-internal and moves
 * neither DOM focus nor scroll.
 */
export function WidgetFocus({ children, nodeKey }: WidgetFocusProps) {
  const [editor] = useLexicalComposerContext();
  const [isSelected] = useSharedNodeSelection(nodeKey);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    return registerWidgetElement(editor, nodeKey, element);
  }, [editor, nodeKey]);

  return <div ref={frame}>{children(isSelected)}</div>;
}
