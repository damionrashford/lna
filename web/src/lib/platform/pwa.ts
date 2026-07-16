// PWA integration: consume content the OS hands an installed AUTOMO — Web Share Target (shared
// title/text/url arrive as query params), File Handlers (files opened "with AUTOMO" via the Launch
// Queue), the web+automo:// protocol, and the "New chat" shortcut — plus capture the install prompt.
// Patterns from PWA-LAB. Anything ingested lands in store.intake and prefills the composer.
import { setIntake, setCanInstall, logEvent } from "../../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
let deferredPrompt: any = null;

export function initPwa(): void {
  // capture the install prompt so we can offer an in-app Install button (Chromium)
  window.addEventListener("beforeinstallprompt", (e: any) => { e.preventDefault(); deferredPrompt = e; setCanInstall(true); });
  window.addEventListener("appinstalled", () => { deferredPrompt = null; setCanInstall(false); logEvent("info", "AUTOMO installed"); });

  // 1. Share Target + protocol handler + shortcut — all arrive as URL params on start_url
  try {
    const p = new URLSearchParams(location.search);
    const shared = [p.get("title"), p.get("text"), p.get("url"), p.get("cmd")].filter(Boolean).join("\n").trim();
    if (shared) { setIntake(shared); logEvent("info", "PWA: received shared content"); }
    if (p.get("new") === "1") { void newChat(); }
    if (shared || p.has("new")) history.replaceState(null, "", location.pathname); // clean the URL
  } catch { /* no params */ }

  // 2. File Handlers — files opened with AUTOMO come through the Launch Queue
  const lq = (window as any).launchQueue;
  if (lq?.setConsumer) {
    lq.setConsumer(async (params: any) => {
      if (!params?.files?.length) return;
      const parts: string[] = [];
      for (const handle of params.files) {
        try { const f = await handle.getFile(); parts.push(`# ${f.name}\n${(await f.text()).slice(0, 20000)}`); } catch { /* unreadable */ }
      }
      if (parts.length) { setIntake(parts.join("\n\n")); logEvent("info", `PWA: opened ${parts.length} file(s)`); }
    });
  }
}

async function newChat() { try { const { createSession } = await import("../agent/index"); await createSession(); } catch { /* noop */ } }

// Trigger the captured install prompt (returns the user's choice, or null if unavailable).
export async function promptInstall(): Promise<string | null> {
  if (!deferredPrompt) return null;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null; setCanInstall(false);
  return outcome;
}
