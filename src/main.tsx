import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalDiagnostics } from "./lib/diagnostics";
import { applyTheme, loadTheme, watchSystemTheme } from "./lib/theme";
import "./styles/index.css";

/* public/theme-boot.js already did this before the first paint; running it
   again is idempotent and covers the paths where that file never ran (a test
   renderer, a stripped index.html). */
applyTheme(loadTheme());
installGlobalDiagnostics();

/* Only "system" needs watching, and only for the inline ground colour and the
   theme-color meta — tokens.css repaints the app itself through
   `@media (prefers-color-scheme)` with no JavaScript involved. The listener is
   never torn down because it lives exactly as long as the window does. */
watchSystemTheme(() => {
  if (loadTheme() === "system") applyTheme("system");
});

/* PolStudio is an application window, not a web page. The browser's own
   context menu offers Back, Reload, View source and Inspect — none of which
   mean anything here, and Reload throws away unsaved project edits. Text
   fields keep theirs: cut/copy/paste/undo are real editing commands, and
   taking them away would cost the user more than the menu is worth. */
document.addEventListener("contextmenu", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
