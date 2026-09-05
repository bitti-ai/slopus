/* Light / dark appearance.
 *
 * Which theme this computer shows is a property of THIS computer and of the
 * person sitting at it — not of a project. It therefore lives in localStorage
 * next to the engine paths (see settings.ts for why machine-level settings
 * never go into slopus.json), and a project folder copied here from another
 * machine does not bring somebody else's appearance with it.
 *
 * THREE states, not two:
 *
 *   "system"  follow the computer, LIVE. No attribute is written, so
 *             `@media (prefers-color-scheme: light)` in tokens.css does the
 *             work and an OS flip while the app is open repaints with no JS
 *             involved at all.
 *   "light"   <html data-theme="light">
 *   "dark"    <html data-theme="dark">
 *
 * An explicit choice beats the OS in BOTH directions. That is a property of
 * the CSS, not of this file: the light rules are guarded by
 * `:root:not([data-theme="dark"])`, so "dark" on a light computer really does
 * fall back to the bare `:root` dark palette. Do not "simplify" that guard.
 */

export type ThemeChoice = "system" | "light" | "dark";

/** What actually gets painted once the choice is resolved against the OS. */
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "slopus.theme.v1";
const LEGACY_THEME_KEY = "polstudio.theme.v1";

export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

/* The two grounds, duplicated from tokens.css (--bg). They are needed BEFORE
   any stylesheet exists — the boot snippet in index.html paints the document
   with one of them so the window never flashes the other theme — so this is
   the one place a raw colour is allowed outside tokens.css. Keep them in step
   with `--bg`; the test in theme.test.ts reads tokens.css and fails if they
   drift. */
export const THEME_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: "#080a0f",
  light: "#eef1f6",
};

const isChoice = (value: unknown): value is ThemeChoice =>
  value === "system" || value === "light" || value === "dark";

/** Anything unrecognised — a hand-edited entry, a value from a future version
 *  — reads as "system" rather than taking the whole app down. */
export function loadTheme(): ThemeChoice {
  try {
    const current = localStorage.getItem(THEME_KEY);
    const value = current ?? localStorage.getItem(LEGACY_THEME_KEY);
    if (!current && value) localStorage.setItem(THEME_KEY, value);
    return isChoice(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* A full or disabled localStorage costs the preference next launch, not
       the session: applyTheme has already repainted. */
  }
}

/** What the computer itself is set to, right now. */
export function systemTheme(): ResolvedTheme {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

/** Writes the choice onto <html> and repaints the document ground.
 *
 *  The ground is set inline as well as by CSS because index.html sets it that
 *  way before the stylesheet has loaded; leaving a stale inline colour behind
 *  would out-specify the stylesheet and strand the old theme's background
 *  under the new theme's panels. */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);

  const resolved = resolveTheme(choice);
  root.style.backgroundColor = THEME_BACKGROUND[resolved];

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_BACKGROUND[resolved]);

  return resolved;
}

/** Calls back whenever the COMPUTER's setting changes. Returns an unsubscribe.
 *  Only "system" needs it — the CSS repaints on its own, but the settings
 *  screen has to keep saying which one the computer is currently on, and the
 *  inline ground colour above has to be rewritten. */
export function watchSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia("(prefers-color-scheme: light)");
  const handler = () => onChange(query.matches ? "light" : "dark");
  /* Safari below 14 only has the deprecated form; a desktop webview that lacks
     addEventListener would otherwise throw on startup. */
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }
  query.addListener(handler);
  return () => query.removeListener(handler);
}
