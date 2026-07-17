// fetch with the Local Network Access loopback hint, plus address-space classification and a bridge
// liveness probe.
import { trimUrl, setCap } from "../../store";

// Chrome's Local Network Access gating requires the `targetAddressSpace: "loopback"` hint for a public
// HTTPS page to reach localhost; fall back to a plain fetch where the option is unsupported.
export function localFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  try { return fetch(url, { ...opts, targetAddressSpace: "loopback" } as RequestInit); }
  catch { return fetch(url, opts); }
}

// no-cors reachability: resolves (opaque) if Ollama answers and LNA is granted, even when CORS blocks the read.
export async function probeReachable(): Promise<boolean> {
  try { await localFetch(trimUrl() + "/api/version", { mode: "no-cors" }); return true; }
  catch { return false; }
}

// Ping the local bridge daemon's HTTP root and reflect its liveness in the "bridge" capability dot.
// The agent's real shell/filesystem run through the SDK's SandboxAgent capabilities, not this probe.
export async function probeBridge() {
  try {
    const res = await localFetch("http://localhost:7967/", { method: "GET" });
    if (res.ok) { setCap("bridge", "ok", "ready · shell + filesystem"); return; }
  } catch { /* not running */ }
  setCap("bridge", "", "not running");
}

// Ask the bridge for exact host hardware (RAM/VRAM/chip) to refine the browser's coarse recommendation.
// Returns null when the bridge isn't running; detection then stays at the WebGPU-derived estimate.
export async function probeBridgeHardware(): Promise<any | null> {
  try {
    const res = await localFetch("http://localhost:7967/hw", { method: "GET" });
    if (res.ok) return await res.json();
  } catch { /* bridge not running */ }
  return null;
}

// Classify a URL's target address space (loopback / local LAN) for LNA-hinted fetches.
export function spaceFor(url: string): "loopback" | "local" | null {
  try {
    const h = new URL(url).hostname;
    if (/^(localhost|127\.|\[?::1)/.test(h)) return "loopback";
    if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /\.local$/.test(h)) return "local";
  } catch { /* not a URL */ }
  return null;
}
