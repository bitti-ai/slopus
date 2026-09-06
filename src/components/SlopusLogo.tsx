import icon from "../../marketing/icon.png";

interface SlopusLogoProps {
  compact?: boolean;
  decorative?: boolean;
  className?: string;
}

export function SlopusLogo({ compact = false, decorative = false, className = "" }: SlopusLogoProps) {
  const classes = ["slopus-logo", compact ? "slopus-logo--compact" : "", className].filter(Boolean).join(" ");
  return <img className={classes} src={icon} alt={decorative ? "" : "Slopus"} aria-hidden={decorative || undefined} />;
}
