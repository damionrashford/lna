// Background Fetch — OS-level download of model weights that SURVIVES navigation and closing the tab,
// with native download UI. On success the service worker (see build.ts) caches the records into the
// "automo-weights" cache, and its fetch handler serves them to the in-browser ML libs (transformers.js /
// kokoro / web-llm) so first inference doesn't re-download multi-MB weights. From PWA-LAB capabilities.
import { logEvent } from "../../store";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function bgFetchSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    typeof (globalThis as any).BackgroundFetchManager !== "undefined";
}

export interface BgFetchHandle { id: string; abort(): Promise<boolean>; }

// Start (or resume) a background download of `urls` under a stable `id`. onProgress reports 0..1.
export async function prefetchWeights(
  id: string, urls: string[], title: string, onProgress?: (fraction: number) => void,
): Promise<BgFetchHandle | null> {
  if (!bgFetchSupported() || !urls.length) { logEvent("warn", "background fetch unsupported — weights load on first use"); return null; }
  const reg: any = await navigator.serviceWorker.ready;
  if (!("backgroundFetch" in reg)) return null;
  // resume an in-flight registration with the same id instead of starting a duplicate
  const existing = await reg.backgroundFetch.get(id);
  const bgf = existing ?? (await reg.backgroundFetch.fetch(id, urls, {
    title,
    downloadTotal: 0, // unknown up front; the UI still shows progress from the record sizes
    icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }],
  }));
  if (onProgress) {
    bgf.addEventListener("progress", () => {
      const total = bgf.downloadTotal || 0;
      onProgress(total ? Math.min(1, bgf.downloaded / total) : 0);
    });
  }
  logEvent("info", `background fetch "${id}" started — ${urls.length} file(s)`);
  return { id, abort: () => bgf.abort() };
}

// Has a given weight set already been cached (so we can skip the fetch)?
export async function weightsCached(urls: string[]): Promise<boolean> {
  try {
    const cache = await caches.open("automo-weights");
    const hits = await Promise.all(urls.map((u) => cache.match(u)));
    return hits.every(Boolean);
  } catch { return false; }
}
