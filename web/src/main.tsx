import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { boot } from "./lib/agent";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

boot();

// Service worker precaches the app shell (installable PWA, fast loads). Registered relative to the
// document so it works under /lna/ or a custom domain. It caches only the shell, not the chat backend.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(new URL("sw.js", document.baseURI).href).catch(() => {});
  });
}
