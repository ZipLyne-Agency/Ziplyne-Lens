import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyTheme } from "./lib/theme.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/screens.css";

// index.html's inline bootstrap already set data-theme for the first paint;
// this re-asserts it once the module graph is up.
applyTheme();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
