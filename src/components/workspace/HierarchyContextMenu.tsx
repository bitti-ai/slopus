import type { ReactNode } from "react";
import { ContextMenu, type MenuEntry } from "../ui/ContextMenu";

/* The image editor's menus, kept as a thin adapter over the shared
   ContextMenu (src/components/ui) so ImageEditor keeps its item shape:
   `separator: true` on an item draws a divider ABOVE it, and `action` is the
   command. New screens should use ContextMenu / useContextMenu directly. */

export interface HierarchyMenuItem {
  label: string; icon: ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean; separator?: boolean; action: () => void;
}

export function toMenuEntries(items: HierarchyMenuItem[]): MenuEntry[] {
  return items.flatMap((item, index): MenuEntry[] => {
    const entry: MenuEntry = {
      id: item.label, label: item.label, icon: item.icon, shortcut: item.shortcut, disabled: item.disabled, danger: item.danger, onSelect: item.action,
    };
    return item.separator && index > 0 ? [{ separator: true, id: `separator-${item.label}` }, entry] : [entry];
  });
}

export function HierarchyContextMenu({ x, y, items, onClose, label = "Image hierarchy actions" }: { x: number; y: number; items: HierarchyMenuItem[]; onClose: () => void; label?: string }) {
  return <ContextMenu position={{ x, y }} items={toMenuEntries(items)} onClose={onClose} aria-label={label} />;
}
