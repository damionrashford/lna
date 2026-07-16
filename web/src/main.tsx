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

// Register the service worker (precaches the app shell → installable PWA + instant loads).
// Resolved relative to the document, so it works under /lna/ or a custom domain. Chat still
// needs your local model/bridge — the SW only makes the app shell load offline/fast.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(new URL("sw.js", document.baseURI).href).catch(() => {});
  });
}
