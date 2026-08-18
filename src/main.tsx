import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";

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
