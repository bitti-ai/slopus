export type ReferenceIconAutomation = "ask" | "enabled" | "disabled";

const STORAGE_KEY = "slopus.reference-icon-automation.v1";
const CHANGE_EVENT = "slopus:reference-icon-automation-changed";
let sessionOverride: ReferenceIconAutomation | undefined;

export function loadReferenceIconAutomation(): ReferenceIconAutomation {
  if (sessionOverride) return sessionOverride;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "enabled" || value === "disabled" ? value : "ask";
  } catch {
    return "ask";
  }
}

export function saveReferenceIconAutomation(value: ReferenceIconAutomation) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
    sessionOverride = undefined;
  } catch {
    sessionOverride = value;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeReferenceIconAutomation(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
