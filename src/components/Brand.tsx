import { SlopusLogo } from "./SlopusLogo";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "brand brand--compact" : "brand"} role="img" aria-label="Slopus">
      <SlopusLogo compact={compact} decorative />
      {!compact && <span className="brand__edition">BETA</span>}
    </div>
  );
}
