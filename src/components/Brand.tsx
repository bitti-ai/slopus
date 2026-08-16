export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "brand brand--compact" : "brand"} aria-label="Pol Studio">
      <div className="brand__lens">
        <img src="/logo.png" alt="Pol Studio" />
      </div>
      {!compact && <span className="brand__edition">BETA</span>}
    </div>
  );
}

