import { ChevronRight16 } from "./ui/icons";
import type { ReactNode } from "react";

/* A settings card that opens something (a generator, a LoRA) AND carries its
   own buttons. A button cannot hold buttons, so the open action is a
   transparent button laid under the card, the way the SettingsExpander header
   is built; the trailing controls sit above it and take their own presses. */
export function OpenableCard({ icon, header, description, progress, openLabel, onOpen, actions, className, openRef }: {
  icon: ReactNode; header: ReactNode; description?: ReactNode; progress?: ReactNode; openLabel: string; onOpen: () => void;
  actions?: ReactNode; className?: string; openRef?: string;
}) {
  return <div className={`ui-settings-card settings-open-card${className ? ` ${className}` : ""}`} role="listitem">
    <button type="button" className="settings-open-card__open" aria-label={openLabel} data-open-ref={openRef} onClick={onOpen} />
    <span className="ui-settings-card__icon" aria-hidden="true">{icon}</span>
    <span className="ui-settings-card__text">
      <span className="ui-settings-card__header">{header}</span>
      {description && <span className="ui-settings-card__description">{description}</span>}
      {progress}
    </span>
    <span className="ui-settings-card__control settings-open-card__control">
      {actions}
      <ChevronRight16 aria-hidden="true" className="ui-settings-card__glyph" />
    </span>
  </div>;
}
