/* ============================================================================
   Undo / redo — snapshot history with coalescing.

   The history stores whole snapshots of a value (a scene, a clip's settings,
   a project config). Snapshots of immutable state are cheap: unchanged
   branches are shared. Before a change, the CURRENT value is recorded; undo
   swaps the present for the most recent record and pushes the present onto
   the redo side.

   Rapid edits that carry the same `key` within `mergeWindowMs` coalesce into
   one step — dragging a slider or typing into a field is one undo, not two
   hundred. `seal()` ends a coalescing run explicitly (call it on pointerup or
   blur) so the next edit with the same key starts a new step.

     const history = createUndoStack<Scene>({ limit: 100, mergeWindowMs: 600 });
     history.record(scene, "opacity");  // before applying a change
     const previous = history.undo(scene);  // → the snapshot to restore, or undefined

   In React, `useUndoStack(present, apply)` wraps the same thing:

     const history = useUndoStack(scene, setScene);
     history.commit(next, "opacity");   // record + apply
     history.undo(); history.redo(); history.canUndo;
   ========================================================================== */

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

export interface UndoOptions {
  /** Maximum undo steps kept (default 100). The oldest are dropped. */
  limit?: number;
  /** Edits with the same key within this many ms merge into one step (default 500; 0 disables). */
  mergeWindowMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface UndoStack<T> {
  /** Save `current` as an undo step before it is replaced. Clears redo. */
  record(current: T, key?: string): void;
  /** Return the snapshot to restore, moving `current` onto the redo side. */
  undo(current: T): T | undefined;
  /** Return the snapshot to restore, moving `current` onto the undo side. */
  redo(current: T): T | undefined;
  /** End the current coalescing run. */
  seal(): void;
  clear(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  /** Change notifications (for React / UI state). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Bumps on every change; a cheap snapshot for useSyncExternalStore. */
  readonly version: number;
}

export function createUndoStack<T>(options: UndoOptions = {}): UndoStack<T> {
  const limit = Math.max(1, options.limit ?? 100);
  const mergeWindow = options.mergeWindowMs ?? 500;
  const now = options.now ?? (() => Date.now());
  const past: T[] = [];
  const future: T[] = [];
  let lastKey: string | undefined;
  let lastTime = -Infinity;
  let version = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    record(current, key) {
      const time = now();
      const merge = key !== undefined && key === lastKey && mergeWindow > 0 && time - lastTime <= mergeWindow && past.length > 0;
      lastKey = key;
      lastTime = time;
      const hadFuture = future.length > 0;
      future.length = 0;
      if (merge) {
        // The earliest snapshot of the run is already on the stack.
        if (hadFuture) changed();
        return;
      }
      past.push(current);
      if (past.length > limit) past.splice(0, past.length - limit);
      changed();
    },
    undo(current) {
      const previous = past.pop();
      if (previous === undefined) return undefined;
      future.push(current);
      lastKey = undefined;
      changed();
      return previous;
    },
    redo(current) {
      const next = future.pop();
      if (next === undefined) return undefined;
      past.push(current);
      lastKey = undefined;
      changed();
      return next;
    },
    seal() {
      lastKey = undefined;
    },
    clear() {
      if (!past.length && !future.length) return;
      past.length = 0;
      future.length = 0;
      lastKey = undefined;
      changed();
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get undoDepth() { return past.length; },
    get redoDepth() { return future.length; },
    get version() { return version; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export interface UndoController<T> {
  /** Record the present and apply `next`. Same key within the merge window = one step. */
  commit(next: T, key?: string): void;
  /** Record the present without applying anything (the caller applies the change). */
  record(key?: string): void;
  undo(): boolean;
  redo(): boolean;
  seal(): void;
  clear(): void;
  canUndo: boolean;
  canRedo: boolean;
  stack: UndoStack<T>;
}

/**
 * React binding. `present` is the current value; `apply` replaces it (a state
 * setter works). The stack lives as long as the component.
 */
export function useUndoStack<T>(present: T, apply: (value: T) => void, options: UndoOptions = {}): UndoController<T> {
  const stackRef = useRef<UndoStack<T>>();
  if (!stackRef.current) stackRef.current = createUndoStack<T>(options);
  const stack = stackRef.current;
  const presentRef = useRef(present);
  presentRef.current = present;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useSyncExternalStore(stack.subscribe, () => stack.version, () => stack.version);

  const commit = useCallback((next: T, key?: string) => {
    stack.record(presentRef.current, key);
    presentRef.current = next;
    applyRef.current(next);
  }, [stack]);
  const record = useCallback((key?: string) => stack.record(presentRef.current, key), [stack]);
  const undo = useCallback(() => {
    const previous = stack.undo(presentRef.current);
    if (previous === undefined) return false;
    presentRef.current = previous;
    applyRef.current(previous);
    return true;
  }, [stack]);
  const redo = useCallback(() => {
    const next = stack.redo(presentRef.current);
    if (next === undefined) return false;
    presentRef.current = next;
    applyRef.current(next);
    return true;
  }, [stack]);
  const seal = useCallback(() => stack.seal(), [stack]);
  const clear = useCallback(() => stack.clear(), [stack]);

  const { canUndo, canRedo } = stack;
  return useMemo(
    () => ({ commit, record, undo, redo, seal, clear, canUndo, canRedo, stack }),
    [commit, record, undo, redo, seal, clear, canUndo, canRedo, stack],
  );
}
