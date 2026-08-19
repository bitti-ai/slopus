/* Applies the saved theme BEFORE the first paint.
 *
 * Why a separate file rather than an inline <script> in index.html: the app's
 * CSP (src-tauri/tauri.conf.json) is `script-src 'self'` with no
 * 'unsafe-inline', so an inline snippet silently does nothing inside the
 * desktop app and every light-theme user gets a black flash on launch. A
 * same-origin file satisfies 'self'.
 *
 * Why a CLASSIC script and not a module: <script type="module"> is deferred,
 * which is after the first paint. A plain <script src> in <head> blocks the
 * parser, so this runs before anything is on screen.
 *
 * It writes the same attribute and ground colour that src/lib/theme.ts writes,
 * and deliberately duplicates the storage key and the two --bg values, because
 * nothing here may depend on the bundle having loaded. theme.test.ts pins both
 * copies against tokens.css so they cannot drift apart in silence.
 */
(function () {
  var GROUND = { dark: "#080a0f", light: "#eef1f6" };
  var choice = "system";
  try {
    var stored = localStorage.getItem("polstudio.theme.v1");
    if (stored === "light" || stored === "dark" || stored === "system") choice = stored;
  } catch (error) {
    /* Private mode, or storage disabled: fall through to following the OS. */
  }

  var root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);

  var resolved = choice;
  if (choice === "system") {
    resolved =
      typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  }
  root.style.backgroundColor = GROUND[resolved];
})();
