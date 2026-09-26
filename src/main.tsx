import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { FluentRuntime } from "./components/ui";
import { installGlobalDiagnostics } from "./lib/diagnostics";
import { followSystemAccent, installBrowserGuards } from "./lib/nativeShell";
import { applyTheme, loadTheme, watchSystemTheme } from "./lib/theme";
import "./styles/index.css";

/* public/theme-boot.js already did this before the first paint; running it
   again is idempotent and covers the paths where that file never ran (a test
   renderer, a stripped index.html). */
applyTheme(loadTheme());
installGlobalDiagnostics();

/* Only "system" needs watching: data-theme names the resolved theme, so an
   OS flip has to rewrite it (and the inline ground colour) for tokens.css to
   repaint. The listener is never torn down because it lives exactly as long
   as the window does. */
watchSystemTheme(() => {
  if (loadTheme() === "system") applyTheme("system");
});

/* The Windows accent colour replaces the palette's own blue, live; with no
   accent to read (a browser, Windows without UISettings) tokens.css stays. */
followSystemAccent();

/* Slopus is an application window, not a web page. The browser's own
   context menu offers Back, Reload, View source and Inspect — none of which
   mean anything here — and F5 / Ctrl+R reload the page and throw away
   unsaved project edits. Text fields and compiled prompts keep a menu, but a
   native Cut/Copy/Paste/Select all one rather than Edge's. A dropped file
   no longer navigates the window away. See installBrowserGuards. */
installBrowserGuards();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    {/* Delegated [data-tooltip] tooltips and the filled track on every slider. */}
    <FluentRuntime />
  </React.StrictMode>,
);
