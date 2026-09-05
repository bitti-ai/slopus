interface SlopusLogoProps {
  compact?: boolean;
  decorative?: boolean;
  className?: string;
}

export function SlopusLogo({ compact = false, decorative = false, className = "" }: SlopusLogoProps) {
  const classes = ["slopus-logo", compact ? "slopus-logo--compact" : "", className].filter(Boolean).join(" ");

  return (
    <span
      className={classes}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Slopus"}
      aria-hidden={decorative || undefined}
    >
      <span className="slopus-logo__ticket">
        {/* The perforations are punched out of the plate by a mask, so they are
            real holes and the page shows through them. These four <i> are the
            strip they occupy in the row, and the black fallback squares for a
            browser that cannot composite the mask. See .slopus-logo* in shell.css. */}
        <span className="slopus-logo__perforations" aria-hidden="true"><i /><i /><i /><i /></span>
        {/* The full lockup keeps “Slop” inside the film badge. The compact
            application mark uses one letter so it remains legible at icon size. */}
        <span className="slopus-logo__monogram">{compact ? "S" : "Slop"}</span>
      </span>
      {!compact && <span className="slopus-logo__wordmark">us</span>}
    </span>
  );
}
