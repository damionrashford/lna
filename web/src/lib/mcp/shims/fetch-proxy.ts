// Routes a bundled in-page server's cross-origin fetches through a CORS proxy so it can read responses
// from hosts that don't send CORS headers. Same-origin passes through untouched; proxy is configurable
// via globalThis.__corsProxy. Import only when a server needs it — it patches the global fetch.
/* eslint-disable @typescript-eslint/no-explicit-any */
const orig = globalThis.fetch.bind(globalThis);
const PROXY = (globalThis as any).__corsProxy ?? "https://corsproxy.io/?url=";

(globalThis as any).fetch = (input: any, init?: any) => {
  try {
    const raw = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin && (u.protocol === "https:" || u.protocol === "http:")) {
      const proxied = PROXY + encodeURIComponent(u.href);
      if (input instanceof Request) return orig(new Request(proxied, input), init);
      return orig(proxied, init);
    }
  } catch { /* fall through to original */ }
  return orig(input, init);
};
export {};
