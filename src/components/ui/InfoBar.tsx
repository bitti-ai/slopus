/* InfoBar — an inline, full-width status message (WinUI InfoBar).

   Sits in the flow of the page (under a command bar, at the top of a pane),
   never floats in a corner. A severity tint and a 16px filled glyph, the
   title in semibold followed by the message on the same line, an optional
   action and an optional 32px close button.

     <InfoBar severity="error" title="Export failed" message={error} onClose={dismiss} />
     <InfoBar severity="success" title="Saved" message={path} action={<button className="secondary-button">Open folder</button>} />
*/

import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./internal";

export type InfoBarSeverity = "informational" | "success" | "warning" | "error";

export interface InfoBarProps {
  severity?: InfoBarSeverity;
  title?: ReactNode;
  /** The message; `children` works too. */
  message?: ReactNode;
  children?: ReactNode;
  /** A button or link at the trailing end. */
  action?: ReactNode;
  /** Shows the close button when set. */
  onClose?: () => void;
  closeLabel?: string;
  /** Hide the severity glyph. */
  hideIcon?: boolean;
  className?: string;
  id?: string;
}

/** The 16px filled severity glyph, also used by InfoBadge-like spots. */
export function SeverityGlyph({ severity }: { severity: InfoBarSeverity }) {
  return (
    <span className={cx("ui-severity-glyph", `ui-severity-glyph--${severity}`)} aria-hidden="true">
      {severity === "success" ? <Check size={10} strokeWidth={3} />
        : severity === "error" ? <X size={10} strokeWidth={3} />
          : <span className="ui-severity-glyph__mark">{severity === "warning" ? "!" : "i"}</span>}
    </span>
  );
}

export function InfoBar({ severity = "informational", title, message, children, action, onClose, closeLabel = "Close", hideIcon, className, id }: InfoBarProps) {
  const body = message ?? children;
  return (
    <div id={id} className={cx("ui-infobar", `ui-infobar--${severity}`, className)} role={severity === "error" ? "alert" : "status"}>
      {!hideIcon && <SeverityGlyph severity={severity} />}
      <div className="ui-infobar__text">
        {title && <strong className="ui-infobar__title">{title}</strong>}
        {body && <span className="ui-infobar__message">{body}</span>}
      </div>
      {action && <div className="ui-infobar__action">{action}</div>}
      {onClose && (
        <button type="button" className="icon-button ui-infobar__close" aria-label={closeLabel} data-tooltip={closeLabel} onClick={onClose}>
          <X size={16} />
        </button>
      )}
    </div>
  );
}
