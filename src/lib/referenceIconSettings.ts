export type ReferenceIconAutomation = "ask" | "enabled" | "disabled";

const BUILTIN_KEY = "slopus.builtin-reference-icons.v1";
const BUILTIN_VISITED_KEY = "slopus.builtin-reference-icons.visited";
let builtinOverride: ReferenceIconAutomation | undefined;
let visitedWithoutStorage = false;

export function saveBuiltinIconChoice(confirmed: boolean) {
  const choice = confirmed ? "enabled" : "disabled";
  try { localStorage.setItem(BUILTIN_KEY, choice); builtinOverride = undefined; }
  catch { builtinOverride = choice; }
}

/** Ask once per app session until the user remembers either answer. */
export function builtinIconVisitAction(): "ask" | "generate" | "skip" {
  let choice: string | null | undefined = builtinOverride;
  try { choice ??= localStorage.getItem(BUILTIN_KEY); } catch { /* Session fallback. */ }
  if (choice === "enabled") return "generate";
  if (choice === "disabled") return "skip";
  try {
    if (sessionStorage.getItem(BUILTIN_VISITED_KEY)) return "skip";
    sessionStorage.setItem(BUILTIN_VISITED_KEY, "true");
  } catch {
    if (visitedWithoutStorage) return "skip";
    visitedWithoutStorage = true;
  }
  return "ask";
}

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
