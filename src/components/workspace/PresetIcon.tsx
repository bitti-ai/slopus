import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { builtinIconRevision, builtinIconUrl, hasBuiltinIcon, loadBuiltinIcon, subscribeBuiltinIcons } from "../../lib/builtinReferenceIcons";
import type { ReferencePreset } from "../../lib/reference-presets";

/** Shared disk artwork is loaded only when its card enters the viewport. */
export function PresetIcon({ preset, className, alt = "" }: { preset: ReferencePreset; className?: string; alt?: string }) {
  const revision = useSyncExternalStore(subscribeBuiltinIcons, builtinIconRevision);
  const marker = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState(false);
  const [url, setUrl] = useState(() => builtinIconUrl(preset.id) ?? preset.icon);
  const available = hasBuiltinIcon(preset.id);
  useEffect(() => {
    setError(false);
    setUrl(builtinIconUrl(preset.id) ?? preset.icon);
    if (!available || builtinIconUrl(preset.id)) return;
    let disposed = false;
    const load = () => { void loadBuiltinIcon(preset.id).then((value) => { if (!disposed) setUrl(value); }).catch(() => { if (!disposed) setError(true); }); };
    if (typeof IntersectionObserver === "undefined" || !marker.current) { load(); return () => { disposed = true; }; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: "200px" });
    observer.observe(marker.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [preset.id, preset.icon, available, revision]);
  if (url) return <img className={className} src={url} alt={alt} loading="lazy" />;
  return <span ref={marker} className={className} role={alt ? "img" : undefined} aria-label={alt || undefined} title={error ? "Could not load icon" : undefined} />;
}
