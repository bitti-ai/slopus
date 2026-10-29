const KEY = "slopus.generation-previews.v1";
const EVENT = "slopus:generation-previews-changed";
let sessionOverride: boolean | undefined;

export function loadGenerationPreviewsEnabled(): boolean {
  if (sessionOverride !== undefined) return sessionOverride;
  try { return localStorage.getItem(KEY) !== "false"; }
  catch { return true; }
}

export function saveGenerationPreviewsEnabled(enabled: boolean) {
  try { localStorage.setItem(KEY, String(enabled)); sessionOverride = undefined; }
  catch { sessionOverride = enabled; }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeGenerationPreviews(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
