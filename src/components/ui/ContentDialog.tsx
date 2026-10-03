/* ContentDialog — the WinUI modal dialog.

   A flat --scrim, a 548px-max panel with 8px corners, a 20px semibold title,
   24px of body padding and a darker footer band holding equal-width buttons
   in the Windows order [Primary][Secondary][Close]. There is no header ×, no
   icon badge and no click-outside dismiss: Esc (and the Close button) close,
   Enter runs the default button.

     <ContentDialog
       title="Save changes to “Lamp”?"
       primaryText="Save" onPrimary={save}
       secondaryText="Don't save" onSecondary={discard}
       closeText="Cancel" onClose={cancel}
       defaultButton="primary"
     >
       Your edits will be lost if you don't save them.
     </ContentDialog>

   Render it conditionally, or keep it mounted and drive `open`. */

import { useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LAYER_ATTR, cx } from "./internal";
import { useModalFocus } from "./useModalFocus";

export type DialogButton = "primary" | "secondary" | "close";

export interface ContentDialogProps {
  /** Default true, so the dialog can simply be rendered conditionally. */
  open?: boolean;
  title: ReactNode;
  children?: ReactNode;
  primaryText?: ReactNode;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  secondaryText?: ReactNode;
  onSecondary?: () => void;
  secondaryDisabled?: boolean;
  /** The dismiss button's label. Omit for a dialog that must be answered with primary/secondary (Esc still calls onClose). */
  closeText?: ReactNode;
  closeDisabled?: boolean;
  /** Called by the Close button and by Esc. */
  onClose: () => void;
  /** Accent-styled, triggered by Enter (outside textareas and buttons). Default: none. */
  defaultButton?: DialogButton | "none";
  /** Marks the primary action as destructive for assistive text only; Fluent has no red buttons. */
  destructive?: boolean;
  /** Max width in px (default 548). */
  width?: number;
  className?: string;
  /** Overrides the default description (the body). */
  "aria-describedby"?: string;
  /** Focus this element first instead of the first focusable in the body. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Disable Esc (e.g. while a save is in flight). */
  disableEscape?: boolean;
}

export function ContentDialog({
  open = true,
  title,
  children,
  primaryText,
  onPrimary,
  primaryDisabled,
  secondaryText,
  onSecondary,
  secondaryDisabled,
  closeText,
  closeDisabled,
  onClose,
  defaultButton = "none",
  destructive,
  width,
  className,
  initialFocus,
  disableEscape,
  ...rest
}: ContentDialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<DialogButton, HTMLButtonElement | null>>>({});
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;

  useModalFocus(panel, {
    active: open,
    initialFocus,
    fallbackFocus: () => (defaultButton !== "none" ? buttons.current[defaultButton] : null) ?? buttons.current.primary ?? buttons.current.secondary ?? buttons.current.close,
  });

  if (!open) return null;

  const run = (which: DialogButton) => {
    if (which === "primary" && !primaryDisabled) onPrimary?.();
    else if (which === "secondary" && !secondaryDisabled) onSecondary?.();
    else if (which === "close" && !closeDisabled) onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && !disableEscape) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && defaultButton !== "none" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
      const target = event.target as HTMLElement;
      if (target.closest("textarea, button, select, a[href], [role=combobox], [role=listbox], [role=menu], [contenteditable=true]")) return;
      const button = buttons.current[defaultButton];
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      run(defaultButton);
    }
  };

  const specs: { which: DialogButton; text: ReactNode; disabled?: boolean }[] = [];
  if (primaryText !== undefined) specs.push({ which: "primary", text: primaryText, disabled: primaryDisabled });
  if (secondaryText !== undefined) specs.push({ which: "secondary", text: secondaryText, disabled: secondaryDisabled });
  if (closeText !== undefined) specs.push({ which: "close", text: closeText, disabled: closeDisabled });

  return createPortal(
    <div className="ui-dialog-scrim" {...{ [LAYER_ATTR]: "dialog" }}>
      <div
        ref={panel}
        className={cx("ui-dialog", className)}
        role={destructive ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={rest["aria-describedby"] ?? (children ? bodyId : undefined)}
        style={width ? { maxWidth: `min(${width}px, calc(100vw - 2 * var(--space-5)))` } : undefined}
        onKeyDown={onKeyDown}
      >
        <div className="ui-dialog__body" data-modal-body>
          <h2 id={titleId} className="ui-dialog__title">{title}</h2>
          {children !== undefined && <div id={bodyId} className="ui-dialog__content">{children}</div>}
        </div>
        {specs.length > 0 && (
          <div className="ui-dialog__footer" style={{ gridTemplateColumns: `repeat(${specs.length}, minmax(0, 1fr))` }}>
            {specs.map(({ which, text, disabled }) => (
              <button
                key={which}
                ref={(element) => { buttons.current[which] = element; }}
                type="button"
                className={cx(which === defaultButton ? "primary-button" : "secondary-button", "ui-dialog__button")}
                data-dialog-button={which}
                disabled={disabled}
                onClick={() => run(which)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
