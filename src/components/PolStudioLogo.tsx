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
