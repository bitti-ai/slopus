// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createUndoStack, useUndoStack, type UndoController } from "./undo";

afterEach(cleanup);

describe("createUndoStack", () => {
  it("undoes and redoes snapshots in order", () => {
    const stack = createUndoStack<number>();
    let value = 0;
    const set = (next: number) => { stack.record(value); value = next; };
    set(1); set(2); set(3);
    expect(stack.canUndo).toBe(true);
    value = stack.undo(value)!; expect(value).toBe(2);
    value = stack.undo(value)!; expect(value).toBe(1);
    expect(stack.canRedo).toBe(true);
    value = stack.redo(value)!; expect(value).toBe(2);
    set(9);
    expect(stack.canRedo).toBe(false);
    value = stack.undo(value)!; expect(value).toBe(2);
    value = stack.undo(value)!; expect(value).toBe(1);
    value = stack.undo(value)!; expect(value).toBe(0);
    expect(stack.undo(value)).toBeUndefined();
  });

  it("coalesces rapid edits with the same key and splits on seal, key or time", () => {
    let time = 0;
    const stack = createUndoStack<number>({ mergeWindowMs: 500, now: () => time });
    stack.record(0, "opacity"); time += 100;
    stack.record(1, "opacity"); time += 100;
    stack.record(2, "opacity");
    expect(stack.undoDepth).toBe(1);
    stack.record(3, "scale");
    expect(stack.undoDepth).toBe(2);
    time += 1000;
    stack.record(4, "scale");
    expect(stack.undoDepth).toBe(3);
    stack.seal();
    stack.record(5, "scale");
    expect(stack.undoDepth).toBe(4);
    // Unkeyed edits never merge.
    stack.record(6); stack.record(7);
    expect(stack.undoDepth).toBe(6);
    expect(stack.undo(8)).toBe(7);
  });

  it("drops the oldest steps past the limit and clears", () => {
    const stack = createUndoStack<number>({ limit: 3 });
    for (let i = 0; i < 5; i += 1) stack.record(i);
    expect(stack.undoDepth).toBe(3);
    expect(stack.undo(5)).toBe(4);
    expect(stack.undo(4)).toBe(3);
    expect(stack.undo(3)).toBe(2);
    expect(stack.undo(2)).toBeUndefined();
    stack.clear();
    expect(stack.canUndo || stack.canRedo).toBe(false);
  });

  it("notifies subscribers", () => {
    const stack = createUndoStack<number>();
    let calls = 0;
    const stop = stack.subscribe(() => { calls += 1; });
    stack.record(1);
    stack.undo(2);
    stop();
    stack.redo(1);
    expect(calls).toBe(2);
  });
});

describe("useUndoStack", () => {
  it("drives React state and re-renders canUndo/canRedo", () => {
    let history!: UndoController<string>;
    let value = "";
    function Editor() {
      const [text, setText] = useState("a");
      value = text;
      history = useUndoStack(text, setText);
      return <span>{history.canUndo ? "can undo" : "clean"}{history.canRedo ? " can redo" : ""}</span>;
    }
    const view = render(<Editor />);
    expect(view.container.textContent).toBe("clean");
    act(() => history.commit("b"));
    act(() => history.commit("c"));
    expect(value).toBe("c");
    expect(view.container.textContent).toBe("can undo");
    act(() => { history.undo(); });
    expect(value).toBe("b");
    expect(view.container.textContent).toBe("can undo can redo");
    act(() => { history.redo(); });
    expect(value).toBe("c");
    act(() => { history.undo(); history.undo(); });
    expect(value).toBe("a");
    expect(history.undo()).toBe(false);
  });
});
