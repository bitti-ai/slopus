/* SettingsCard, SettingsGroup, SettingsExpander — the Windows Settings row.

   A card is a grid: 20px icon | header + description | control. 68px min
   height (48px without a description is fine too), 12px 16px padding, 4px
   corners, the --card fill and a 1px --stroke-card edge. Stacked cards sit
   4px apart inside a SettingsGroup, which can carry a 14px semibold heading.

     <SettingsGroup heading="Appearance">
       <SettingsCard icon={<Palette20 />} header="Theme" description="Light, dark or follow Windows">
         <ComboBox value={theme} onChange={setTheme} options={themes} />
       </SettingsCard>
       <SettingsCard header="About" description="Version 0.1.1" onClick={openAbout} />         // chevron
       <SettingsCard header="Documentation" href="https://…" />                               // external glyph
       <SettingsExpander icon={<Gpu20 />} header="GPU" description="…" control={<ToggleSwitch …/>}>
         <SettingsRow header="Device">…</SettingsRow>
         <SettingsRow header="Memory limit">…</SettingsRow>
       </SettingsExpander>
     </SettingsGroup>
*/

import { ChevronDown16, ChevronRight16, OpenExternal16 } from "./icons";
import { useId, useState, type ReactNode } from "react";
import { cx } from "./internal";

export interface SettingsGroupProps {
  heading?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}

export function SettingsGroup({ heading, children, className, id }: SettingsGroupProps) {
  const headingId = useId();
  return (
    <section id={id} className={cx("ui-settings-group", className)} aria-labelledby={heading ? headingId : undefined}>
      {heading && <h3 id={headingId} className="ui-settings-group__heading">{heading}</h3>}
      <div className="ui-settings-group__cards">{children}</div>
    </section>
  );
}

export interface SettingsCardProps {
  icon?: ReactNode;
  header: ReactNode;
  description?: ReactNode;
  /** The control on the trailing edge (a toggle, a ComboBox, a button). */
  children?: ReactNode;
  /** Makes the whole card a button with a trailing chevron. */
  onClick?: () => void;
  /** Makes the whole card a link with a trailing external glyph. */
  href?: string;
  /** Override the trailing glyph of a clickable card. */
  actionIcon?: "chevron" | "external" | "none";
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function SettingsCard({ icon, header, description, children, onClick, href, actionIcon, disabled, className, id }: SettingsCardProps) {
  const headerId = useId();
  const descriptionId = useId();
  const content = (
    <>
      {icon !== undefined && <span className="ui-settings-card__icon" aria-hidden="true">{icon}</span>}
      <span className="ui-settings-card__text">
        <span id={headerId} className="ui-settings-card__header">{header}</span>
        {description && <span id={descriptionId} className="ui-settings-card__description">{description}</span>}
      </span>
    </>
  );
  const glyph = actionIcon ?? (href ? "external" : "chevron");
  const trailing = (children || glyph !== "none") && (
    <span className="ui-settings-card__control">
      {children}
      {glyph === "chevron" && <ChevronRight16 aria-hidden="true" className="ui-settings-card__glyph" />}
      {glyph === "external" && <OpenExternal16 aria-hidden="true" className="ui-settings-card__glyph" />}
    </span>
  );
  const classes = cx("ui-settings-card", !icon && "ui-settings-card--no-icon", disabled && "ui-settings-card--disabled", className);

  if (href) {
    return (
      <a id={id} className={cx(classes, "ui-settings-card--clickable")} href={disabled ? undefined : href} target="_blank" rel="noreferrer" aria-disabled={disabled || undefined}>
        {content}{trailing}
      </a>
    );
  }
  if (onClick) {
    return (
      <button id={id} type="button" className={cx(classes, "ui-settings-card--clickable")} disabled={disabled} onClick={onClick} aria-describedby={description ? descriptionId : undefined}>
        {content}{trailing}
      </button>
    );
  }
  return (
    <div id={id} className={classes} role="group" aria-labelledby={headerId} aria-describedby={description ? descriptionId : undefined}>
      {content}
      {children !== undefined && <span className="ui-settings-card__control">{children}</span>}
    </div>
  );
}

/* --- Disclosure state shared by the expanders --------------------------------- */

export function useDisclosure(expanded: boolean | undefined, defaultExpanded: boolean | undefined, onExpandedChange?: (expanded: boolean) => void) {
  const [inner, setInner] = useState(Boolean(defaultExpanded));
  const isOpen = expanded ?? inner;
  const toggle = () => {
    const next = !isOpen;
    if (expanded === undefined) setInner(next);
    onExpandedChange?.(next);
  };
  return [isOpen, toggle] as const;
}

export interface SettingsExpanderProps {
  icon?: ReactNode;
  header: ReactNode;
  description?: ReactNode;
  /** A control in the header row, left of the chevron (does not toggle). */
  control?: ReactNode;
  /** Rows shown when expanded; SettingsRow is the usual child. Dividers are drawn between them. */
  children?: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
  id?: string;
}

export function SettingsExpander({ icon, header, description, control, children, expanded, defaultExpanded, onExpandedChange, className, id }: SettingsExpanderProps) {
  const [isOpen, toggle] = useDisclosure(expanded, defaultExpanded, onExpandedChange);
  const base = useId();
  const headerId = `${base}-header`;
  const descriptionId = `${base}-description`;
  const contentId = `${base}-content`;
  return (
    <div id={id} className={cx("ui-settings-expander", isOpen && "ui-settings-expander--open", className)}>
      <div className={cx("ui-settings-card", "ui-settings-expander__header", !icon && "ui-settings-card--no-icon")}>
        {/* The whole row toggles; the control sits above this button. */}
        <button
          type="button"
          className="ui-settings-expander__toggle"
          aria-expanded={isOpen}
          aria-controls={contentId}
          aria-labelledby={headerId}
          aria-describedby={description ? descriptionId : undefined}
          onClick={toggle}
        />
        {icon !== undefined && <span className="ui-settings-card__icon" aria-hidden="true">{icon}</span>}
        <span className="ui-settings-card__text">
          <span id={headerId} className="ui-settings-card__header">{header}</span>
          {description && <span id={descriptionId} className="ui-settings-card__description">{description}</span>}
        </span>
        <span className="ui-settings-card__control">
          {control && <span className="ui-settings-expander__control">{control}</span>}
          <ChevronDown16 aria-hidden="true" className="ui-settings-expander__chevron" />
        </span>
      </div>
      <div id={contentId} className="ui-settings-expander__content" role="region" aria-labelledby={headerId} hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}

export interface SettingsRowProps {
  header: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** A row inside a SettingsExpander: header + description | control, indented past the icon column. */
export function SettingsRow({ header, description, children, className }: SettingsRowProps) {
  const headerId = useId();
  return (
    <div className={cx("ui-settings-row", className)} role="group" aria-labelledby={headerId}>
      <span className="ui-settings-card__text">
        <span id={headerId} className="ui-settings-card__header">{header}</span>
        {description && <span className="ui-settings-card__description">{description}</span>}
      </span>
      {children !== undefined && <span className="ui-settings-card__control">{children}</span>}
    </div>
  );
}
