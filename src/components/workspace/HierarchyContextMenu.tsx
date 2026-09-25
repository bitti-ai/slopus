import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface HierarchyMenuItem {
  label: string; icon: ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean; separator?: boolean; action: () => void;
}
export function HierarchyContextMenu({ x, y, items, onClose, label = "Image hierarchy actions" }: { x: number; y: number; items: HierarchyMenuItem[]; onClose: () => void; label?: string }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) });
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", onClose);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true); window.removeEventListener("resize", onClose); };
  }, [onClose]);
  return createPortal(<div ref={menu} className="image-hierarchy-menu" role="menu" aria-label={label} style={position} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
    event.stopPropagation();
    const shortcut = (event.ctrlKey || event.metaKey) ? `Ctrl+${event.key.toUpperCase()}` : event.key;
    const command = items.find((item) => item.shortcut === shortcut && !item.disabled);
    if (command) { event.preventDefault(); onClose(); command.action(); return; }
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Tab") { event.preventDefault(); onClose(); }
  }}>
    {items.map((item) => <div key={item.label} role="none">
      {item.separator && <div role="separator" />}
      <button type="button" role="menuitem" disabled={item.disabled} className={item.danger ? "danger" : ""} onClick={() => { onClose(); item.action(); }}>{item.icon}<span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>
    </div>)}
  </div>, document.body);
}
