/* Pane anatomy: ItemHeader and EmptyState.

   A pane is headed by what it holds, never by a title bar. When it shows one
   selected thing, an ItemHeader names it; when it has views or actions, a
   PaneHeader (Chrome.tsx) is its toolbar; when it has nothing to show, an
   EmptyState says so and offers the way forward.

     <ItemHeader
       color="var(--clip-generated)" icon={<Sparkles size={16} />}
       name={<input className="ui-item-header__input" value={name} … aria-label="Clip name" />}
       meta="Generated video · V1 · 6.2 s"
       actions={<button className="icon-button" aria-label="More">…</button>} />

     <EmptyState icon={<Film size={32} />} title="No media yet"
       description="Import video, images or audio to use them on the timeline."
       action={<button className="secondary-button" …>Import</button>} />
*/

import type { CSSProperties, ReactNode } from "react";
import { cx } from "./internal";

/* --- ItemHeader ---------------------------------------------------------------
   48px (--item-header) on --surface-chrome with a --stroke-divider bottom
   edge: a 28px kind chip, the name at 14px semibold over one muted 12px meta
   line (kind, location, length), and actions (usually a ⋯ button) on the
   trailing edge. The name is a heading when it is text; pass a node instead
   to make it editable in place (an <input className="ui-item-header__input">
   reads as the heading until it is hovered or focused). */

export interface ItemHeaderProps {
  /** The item's name: text (rendered as a heading) or a node such as an editable input. */
  name: ReactNode;
  /** One muted line under the name: kind, location, length. */
  meta?: ReactNode;
  /** The kind glyph shown white on the kind colour. */
  icon?: ReactNode;
  /** The chip's fill, a CSS colour — usually a kind token: "var(--clip-video)". */
  color?: string;
  /** Replaces the icon chip entirely (a thumbnail, a reference's art); still 28px. */
  chip?: ReactNode;
  /** Trailing controls, compact icon buttons. */
  actions?: ReactNode;
  /** Id for the name heading, so the pane can be aria-labelledby it. */
  id?: string;
  /** Heading level for a text name (default 2). */
  level?: 2 | 3 | 4;
  className?: string;
}

export function ItemHeader({ name, meta, icon, color, chip, actions, id, level = 2, className }: ItemHeaderProps) {
  const Heading = `h${level}` as "h2";
  const text = typeof name === "string" || typeof name === "number";
  const hasChip = chip !== undefined || icon !== undefined || color !== undefined;
  return (
    <div className={cx("ui-item-header", className)}>
      {hasChip && (
        <span
          className={cx("ui-item-header__chip", chip !== undefined && "ui-item-header__chip--custom")}
          style={color ? ({ "--item-kind": color } as CSSProperties) : undefined}
          aria-hidden="true"
        >
          {chip ?? icon}
        </span>
      )}
      <div className="ui-item-header__text">
        {text
          ? <Heading id={id} className="ui-item-header__name">{name}</Heading>
          : <div id={id} className="ui-item-header__name ui-item-header__name--custom">{name}</div>}
        {meta && <div className="ui-item-header__meta">{meta}</div>}
      </div>
      {actions && <div className="ui-item-header__actions">{actions}</div>}
    </div>
  );
}

/* --- EmptyState ---------------------------------------------------------------
   The compact empty state every pane shares: a 32px glyph, a 14px semibold
   title, one muted sentence and at most one action, centred in whatever
   contains it. The Library's large hero is the one exception and keeps its
   own markup. */

export interface EmptyStateProps {
  title: ReactNode;
  /** One muted sentence: why it is empty, or how to fill it. */
  description?: ReactNode;
  /** A 32px glyph. */
  icon?: ReactNode;
  /** One button: the way forward. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cx("ui-empty-state", className)}>
      {icon && <span className="ui-empty-state__icon" aria-hidden="true">{icon}</span>}
      <p className="ui-empty-state__title">{title}</p>
      {description && <p className="ui-empty-state__description">{description}</p>}
      {action && <div className="ui-empty-state__action">{action}</div>}
    </div>
  );
}
