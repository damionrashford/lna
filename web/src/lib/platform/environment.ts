// A live model of what the agent can do right now — connectivity, device health, and capabilities. The run
// context surfaces a compact form into the agent's instructions so it reasons about its own environment
// ("I'm offline, so web_search won't work"), and the scheduler reads it to adapt (back off under thermal
// pressure or low battery). Every probe is best-effort: unsupported APIs simply leave a field undefined.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Environment {
  online: boolean;
  connection?: string;          // effectiveType: "slow-2g" | "2g" | "3g" | "4g"
  saveData?: boolean;
  webgpu: boolean;
  storagePersisted?: boolean;
  battery?: { charging: boolean; level: number };
  pressure?: string;            // Compute Pressure: "nominal" | "fair" | "serious" | "critical"
  notifications?: string;       // Notification permission: "granted" | "denied" | "default"
}

let env: Environment = {
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  webgpu: typeof navigator !== "undefined" && !!(navigator as any).gpu,
};
const listeners = new Set<() => void>();

export function getEnvironment(): Environment { return env; }
export function onEnvironmentChange(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
function update(patch: Partial<Environment>) { env = { ...env, ...patch }; listeners.forEach((l) => l()); }

let started = false;
export function initEnvironment(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  addEventListener("online", () => update({ online: true }));
  addEventListener("offline", () => update({ online: false }));

  const c = (navigator as any).connection;
  if (c) { const set = () => update({ connection: c.effectiveType, saveData: c.saveData }); set(); try { c.addEventListener("change", set); } catch { /* older impls */ } }

  navigator.storage?.persisted?.().then((p) => update({ storagePersisted: p })).catch(() => {});

  (navigator as any).getBattery?.().then((b: any) => {
    const set = () => update({ battery: { charging: b.charging, level: b.level } });
    set(); b.addEventListener("chargingchange", set); b.addEventListener("levelchange", set);
  }).catch(() => {});

  if (typeof Notification !== "undefined") update({ notifications: Notification.permission });

  // Compute Pressure — thermal/CPU state, so the loop can ease off a throttling device.
  try {
    const PO = (globalThis as any).PressureObserver;
    if (PO) new PO((records: any[]) => { const last = records[records.length - 1]; if (last) update({ pressure: last.state }); }).observe("cpu", { sampleInterval: 2000 });
  } catch { /* unsupported */ }
}

// True when heavy in-browser work should back off (thermal pressure high, or low battery on power).
export function shouldThrottle(e = env): boolean {
  if (e.pressure === "serious" || e.pressure === "critical") return true;
  if (e.battery && !e.battery.charging && e.battery.level <= 0.15) return true;
  return false;
}

// Compact, model-facing summary — folded into the agent's instructions.
export function environmentLine(bridgeReady: boolean, e = env): string {
  const bits: (string | null)[] = [
    e.online ? "online" : "OFFLINE — web_search and any remote model are unavailable; answer from context/memory",
    bridgeReady ? "machine bridge connected (real shell/files)" : "no machine bridge (in-browser sandbox only)",
    e.connection ? `network ${e.connection}${e.saveData ? ", data-saver on" : ""}` : null,
    e.webgpu ? null : "no WebGPU (in-browser models run on slower WASM)",
    e.battery ? `battery ${Math.round(e.battery.level * 100)}%${e.battery.charging ? " charging" : ""}` : null,
    e.pressure && e.pressure !== "nominal" ? `device under ${e.pressure} CPU load` : null,
  ];
  return bits.filter(Boolean).join(" · ");
}
