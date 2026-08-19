interface PolStudioLogoProps {
  compact?: boolean;
  decorative?: boolean;
  className?: string;
}

export function PolStudioLogo({ compact = false, decorative = false, className = "" }: PolStudioLogoProps) {
  const classes = ["pol-logo", compact ? "pol-logo--compact" : "", className].filter(Boolean).join(" ");

  return (
    <span
      className={classes}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "PolStudio"}
      aria-hidden={decorative || undefined}
    >
      <span className="pol-logo__ticket">
        {/* The perforations are punched out of the plate by a mask, so they are
            real holes and the page shows through them. These four <i> are the
            strip they occupy in the row, and the black fallback squares for a
            browser that cannot composite the mask. See .pol-logo* in shell.css. */}
        <span className="pol-logo__perforations" aria-hidden="true"><i /><i /><i /><i /></span>
        {/* The compact mark is the small application icon: one letter inside
            the film ticket. "PolS" at icon size was four letters squeezed into
            a space that fits one. */}
        <span className="pol-logo__pols">{compact ? "P" : "PolS"}</span>
      </span>
      {!compact && <span className="pol-logo__tudio">tudio</span>}
    </span>
  );
}
