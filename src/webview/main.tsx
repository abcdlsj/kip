import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import { applyPlatform } from "./lib/platform";
import App from "./App";

// Before the first paint: CSS and the window buttons both key off this.
applyPlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
