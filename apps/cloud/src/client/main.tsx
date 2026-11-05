import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { followWindowChrome } from "./desktop";
import "./styles.css";
import { followSystemTheme } from "./theme";

followSystemTheme();
followWindowChrome();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
