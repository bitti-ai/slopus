import { PolStudioLogo } from "./PolStudioLogo";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "brand brand--compact" : "brand"} aria-label="Pol Studio">
      <PolStudioLogo compact={compact} decorative />
      {!compact && <span className="brand__edition">BETA</span>}
    </div>
  );
}

