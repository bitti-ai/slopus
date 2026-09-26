/* Window chrome pieces: CommandBar, PaneHeader, NavigationView (NavPane,
   NavItem), TextField, StatusBar. */

import {
  forwardRef, useRef,
  type ButtonHTMLAttributes, type ChangeEvent, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref,
} from "react";
import { ariaKeyShortcuts, formatShortcut } from "../../lib/commands";
import { InfoBadge, type InfoBadgeProps } from "./Controls";
import { cx } from "./internal";

/* --- CommandBar --------------------------------------------------------------------
   A 40px row of 32px subtle buttons. role=toolbar; Left/Right move between
   its buttons (every button stays in the Tab order too, which is what the
   app's dense editors expect). No overflow menu. */

export interface CommandBarProps {
  children: ReactNode;
  "aria-label"?: string;
  className?: string;
  /** Content pushed to the trailing edge. */
  end?: ReactNode;
}

export function CommandBar({ children, end, className, ...aria }: CommandBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [role=combobox], [role=slider], [contenteditable=true]")) return;
    const buttons = [...(bar.current?.querySelectorAll<HTMLButtonElement>(".ui-cmd:not(:disabled)") ?? [])];
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  return (
    <div ref={bar} role="toolbar" aria-label={aria["aria-label"]} className={cx("ui-command-bar", className)} onKeyDown={onKeyDown}>
      <div className="ui-command-bar__primary">{children}</div>
      {end && <div className="ui-command-bar__end">{end}</div>}
    </div>
  );
}

export interface CommandBarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon?: ReactNode;
  /** The accessible name and default tooltip. */
  label: string;
  /** Show the label as text next to the icon (default: icon only when there is an icon). */
  showLabel?: boolean;
  /** Tooltip text, when it should differ from the label. */
  tooltip?: string;
  /** A combo ("Ctrl+S"): shown in the tooltip and exposed as aria-keyshortcuts. It does not bind the key — use useShortcut. */
  shortcut?: string;
  /** Toggle buttons: sets aria-pressed and the checked look. */
  pressed?: boolean;
}

export const CommandBarButton = forwardRef(function CommandBarButton(
  { icon, label, showLabel, tooltip, shortcut, pressed, className, type = "button", ...rest }: CommandBarButtonProps,
  ref: Ref<HTMLButtonElement>,
) {
  const withText = showLabel ?? !icon;
  return (
    <button
      ref={ref}
      type={type}
      className={cx("ui-cmd", withText && "ui-cmd--labelled", pressed && "ui-cmd--pressed", className)}
      aria-label={withText ? undefined : label}
      aria-pressed={pressed}
      aria-keyshortcuts={ariaKeyShortcuts(shortcut)}
      /* Always: a labelled button loses its text when the bar is narrow
         (the stylesheet hides .ui-cmd__label), and then the tooltip is all
         that names it. */
      data-tooltip={tooltip ?? label}
      data-tooltip-shortcut={shortcut ? formatShortcut(shortcut) : undefined}
      {...rest}
    >
      {icon && <span className="ui-cmd__icon" aria-hidden="true">{icon}</span>}
      {withText && <span className="ui-cmd__label">{label}</span>}
    </button>
  );
});

export function CommandBarSeparator() {
  return <span className="ui-command-bar__separator" role="separator" aria-orientation="vertical" />;
}

/* --- PaneHeader ------------------------------------------------------------------------
   A pane's toolbar: a 36px (--chrome-row) strip on --surface-chrome with a
   --stroke-divider bottom edge. Views lead (a compact SelectorBar), actions
   sit on the trailing edge. It is only there when the pane HAS views or
   actions, and it should not carry a title — a pane is headed by what it
   holds (ItemHeader) or starts with its content. `title` survives for the
   callers that still pass one: 12px semibold at the leading edge. */

export interface PaneHeaderProps {
  title?: ReactNode;
  /** Leading content after the title: the pane's views, e.g. <SelectorBar compact …/>. */
  views?: ReactNode;
  actions?: ReactNode;
  /** Id for the title, so the pane can be aria-labelledby it. */
  id?: string;
  className?: string;
  /** Heading level for the title (default 2). */
  level?: 2 | 3 | 4;
}

export function PaneHeader({ title, views, actions, id, className, level = 2 }: PaneHeaderProps) {
  const Heading = `h${level}` as "h2";
  return (
    <div className={cx("ui-pane-header", className)}>
      {title !== undefined && <Heading id={id} className="ui-pane-header__title">{title}</Heading>}
      {views && <div className="ui-pane-header__views">{views}</div>}
      {actions && <div className="ui-pane-header__actions">{actions}</div>}
    </div>
  );
}

/* --- NavigationView ---------------------------------------------------------------------
   NavPane is the left rail (a <nav>) with a footer slot for Settings; NavItem
   is a 36px row with a 16px icon, a 3×16px accent pill when selected and an
   optional InfoBadge. */

export interface NavPaneProps {
  children: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
  "aria-label"?: string;
  className?: string;
  /** Icons only (48px rail). */
  compact?: boolean;
}

export function NavPane({ children, footer, header, className, compact, ...aria }: NavPaneProps) {
  return (
    <nav aria-label={aria["aria-label"]} className={cx("ui-nav", compact && "ui-nav--compact", className)}>
      {header && <div className="ui-nav__header">{header}</div>}
      <div className="ui-nav__items">{children}</div>
      {footer && <div className="ui-nav__footer">{footer}</div>}
    </nav>
  );
}

export interface NavItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon?: ReactNode;
  label: ReactNode;
  selected?: boolean;
  /** A number, or `true` for a dot. */
  badge?: number | boolean;
  badgeSeverity?: InfoBadgeProps["severity"];
  /** Accessible label for the badge ("3 running"). */
  badgeLabel?: string;
}

export const NavItem = forwardRef(function NavItem(
  { icon, label, selected, badge, badgeSeverity, badgeLabel, className, type = "button", ...rest }: NavItemProps,
  ref: Ref<HTMLButtonElement>,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("ui-nav-item", selected && "ui-nav-item--selected", className)}
      aria-current={selected ? "page" : undefined}
      {...rest}
    >
      {icon && <span className="ui-nav-item__icon" aria-hidden="true">{icon}</span>}
      <span className="ui-nav-item__label">{label}</span>
      {badge !== undefined && badge !== false && (
        <InfoBadge className="ui-nav-item__badge" value={typeof badge === "number" ? badge : undefined} severity={badgeSeverity} aria-label={badgeLabel} />
      )}
    </button>
  );
});

/* --- TextField --------------------------------------------------------------------------
   The Fluent TextBox as a composite: a 32px wrapper that draws the edge and
   the 2px accent underline on focus, an optional 16px leading icon, the
   borderless input, and optional trailing buttons (clear, reveal, browse). */

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "size"> {
  value: string;
  onChange: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  icon?: ReactNode;
  /** Buttons after the input; use className="ui-textfield__button". */
  trailing?: ReactNode;
  /** Wrapper class. */
  className?: string;
  inputClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
  width?: number | string;
}

export function TextField({ value, onChange, icon, trailing, className, inputClassName, inputRef, width, disabled, ...rest }: TextFieldProps) {
  return (
    <div className={cx("ui-textfield", disabled && "ui-textfield--disabled", className)} style={width !== undefined ? { width } : undefined}>
      {icon && <span className="ui-textfield__icon" aria-hidden="true">{icon}</span>}
      <input
        ref={inputRef}
        className={cx("ui-textfield__input", inputClassName)}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value, event)}
        {...rest}
      />
      {trailing && <span className="ui-textfield__trailing">{trailing}</span>}
    </div>
  );
}

/* --- StatusBar ----------------------------------------------------------------------------
   A 24px (--chrome-row-sm) strip on --surface-chrome along the bottom of a
   window or pane, 12px text: labelled mono values on the leading side, state
   on the trailing side. It is a
   labelled region, not a live region: a playhead timecode would otherwise be
   read out every frame. Put role="status" on the one item that should speak. */

export interface StatusBarProps {
  children: ReactNode;
  /** Items pushed to the trailing edge. */
  end?: ReactNode;
  "aria-label"?: string;
  className?: string;
}

export function StatusBar({ children, end, className, ...aria }: StatusBarProps) {
  return (
    <div role={aria["aria-label"] ? "region" : undefined} aria-label={aria["aria-label"]} className={cx("ui-statusbar", className)}>
      <div className="ui-statusbar__items">{children}</div>
      {end && <div className="ui-statusbar__items ui-statusbar__items--end">{end}</div>}
    </div>
  );
}
