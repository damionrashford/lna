// fetch with the LNA loopback hint, plus address-space classification and a bridge liveness probe.
import { trimUrl, setCap } from "../store";

export function localFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  try { return fetch(url, { ...opts, targetAddressSpace: "loopback" } as RequestInit); }
  catch { return fetch(url, opts); }
}

// no-cors reachability: resolves (opaque) if Ollama answers + LNA is granted, even when CORS blocks the read.
export async function probeReachable(): Promise<boolean> {
  try { await localFetch(trimUrl() + "/api/version", { mode: "no-cors" }); return true; }
  catch { return false; }
}

// ping the local bridge daemon's HTTP root and reflect its liveness in the "bridge" capability dot.
// (The agent's real shell/filesystem run through the SDK's SandboxAgent capabilities, not this.)
export async function probeBridge() {
  try {
    const res = await localFetch("http://localhost:7967/", { method: "GET" });
    if (res.ok) { setCap("bridge", "ok", "ready · shell + filesystem"); return; }
  } catch { /* not running */ }
  setCap("bridge", "", "not running");
}

// classify a URL's target address space (loopback / local LAN) for LNA-hinted fetches
export function spaceFor(url: string): "loopback" | "local" | null {
  try {
    const h = new URL(url).hostname;
    if (/^(localhost|127\.|\[?::1)/.test(h)) return "loopback";
    if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /\.local$/.test(h)) return "local";
  } catch { /* not a URL */ }
  return null;
}
