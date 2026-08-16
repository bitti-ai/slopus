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
      aria-label={decorative ? undefined : "Pol Studio"}
      aria-hidden={decorative || undefined}
    >
      <span className="pol-logo__ticket">
        <span className="pol-logo__perforations" aria-hidden="true"><i /><i /><i /><i /></span>
        <span className="pol-logo__pols">PolS</span>
      </span>
      {!compact && <span className="pol-logo__tudio">tudio</span>}
    </span>
  );
}
