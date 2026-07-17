// Browser-side hardware detection → a coarse machine profile used to recommend a model size and to
// decide whether in-browser (WebGPU/WASM) inference is viable. Everything is feature-detected and
// privacy-limited by design (the browser caps deviceMemory at 8, hides VRAM, etc.), so this is a
// heuristic tier — the bridge (system_profiler / nvidia-smi) refines it to exact numbers when present.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GpuInfo {
  vendor: string;
  architecture: string;
  description: string;
  f16: boolean;        // shader-f16 feature (matters for LLM inference perf)
  maxBufferMiB: number;
  maxStorageBindingMiB: number; // web-llm gates model load on this — a reliable OOM predictor
  fallback: boolean;   // software/fallback adapter → effectively no GPU accel
}

export interface HardwareProfile {
  ramGiB: number | null;        // navigator.deviceMemory (coarse, capped at 8)
  cpuCores: number | null;      // navigator.hardwareConcurrency
  arch: string | null;         // UA Client Hints architecture (e.g. "arm", "x86")
  platform: string | null;     // UA Client Hints platform (e.g. "macOS")
  platformVersion: string | null;
  gpu: GpuInfo | null;         // WebGPU adapter, or null if unavailable
  webgpu: boolean;             // WebGPU present at all
  storageGiB: number | null;   // free-ish OPFS/IDB quota headroom (for in-browser weight caching)
  network: { effectiveType: string; downlinkMbps: number; saveData: boolean } | null;
  onBattery: boolean | null;   // true when discharging (affects powerPreference / heavy inference)
  batteryLevel: number | null; // 0..1 — a low battery discourages a heavy in-browser run
  mobile: boolean | null;      // touch + coarse-pointer heuristic — phones can't run big models
  gpuName: string | null;      // GPU renderer string — from WebGPU, else WebGL (Safari/Firefox have no WebGPU)
  wasm: { simd: boolean; threads: boolean }; // WASM inference speed gates: SIMD, and threads (needs crossOriginIsolated)
}

// GPU renderer string from a WebGL context — the only GPU identity available when WebGPU is absent
// (Safari, Firefox without the flag). May be blank under anti-fingerprinting (Firefox RFP, Brave).
function detectWebglGpu(): string | null {
  try {
    const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    const gl = canvas?.getContext("webgl") || canvas?.getContext("experimental-webgl");
    if (!gl) return null;
    const ext = (gl as any).getExtension("WEBGL_debug_renderer_info");
    const name = ext ? (gl as any).getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    return name || null;
  } catch { return null; }
}

// WebAssembly capability probe. SIMD (fixed-width v128) and threads (shared memory + atomics, which
// need a cross-origin-isolated page) are the two levers that make CPU/WASM inference viable for the
// in-browser engine when there's no WebGPU. SIMD is detected by validating a tiny module that uses it.
function detectWasm(): { simd: boolean; threads: boolean } {
  let simd = false;
  try {
    // minimal module whose body is `v128.const 0 0` — validates only where SIMD is supported
    simd = typeof WebAssembly === "object" && WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch { simd = false; }
  const threads = typeof SharedArrayBuffer !== "undefined" && (globalThis as any).crossOriginIsolated === true;
  return { simd, threads };
}

async function detectGpu(): Promise<GpuInfo | null> {
  const gpu = (navigator as any).gpu;
  if (!gpu?.requestAdapter) return null;
  try {
    // high-performance nudges the discrete GPU on dual-GPU laptops (when on AC)
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const info = (await adapter.requestAdapterInfo?.()) ?? adapter.info ?? {};
    return {
      vendor: info.vendor ?? "",
      architecture: info.architecture ?? "",
      description: info.description ?? info.device ?? "",
      f16: !!adapter.features?.has?.("shader-f16"),
      maxBufferMiB: Math.round((adapter.limits?.maxBufferSize ?? 0) / (1024 * 1024)),
      maxStorageBindingMiB: Math.round((adapter.limits?.maxStorageBufferBindingSize ?? 0) / (1024 * 1024)),
      fallback: !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
    };
  } catch { return null; }
}

// Parse the Firefox-only `navigator.oscpu` string (e.g. "Intel Mac OS X", "Linux x86_64",
// "Windows NT 10.0; Win64; x64") into a coarse {platform, arch} — the fallback when UA Client Hints
// are absent (Firefox ships no userAgentData).
function parseOscpu(s: string): { arch: string | null; platform: string | null } {
  const arch = /x64|Win64|x86_64|amd64|Intel/i.test(s) ? "x86_64" : /arm|aarch64/i.test(s) ? "arm" : /i686|i386|x86/i.test(s) ? "x86" : null;
  const platform = /Mac OS|macOS/i.test(s) ? "macOS" : /Windows/i.test(s) ? "Windows" : /Linux/i.test(s) ? "Linux" : null;
  return { arch, platform };
}

async function detectUaHints(): Promise<{ arch: string | null; platform: string | null; platformVersion: string | null }> {
  const ua = (navigator as any).userAgentData;
  const oscpu = (navigator as any).oscpu as string | undefined; // Firefox-only fallback
  const fb = oscpu ? parseOscpu(oscpu) : { arch: null, platform: null };
  if (!ua?.getHighEntropyValues) return { arch: fb.arch, platform: ua?.platform ?? fb.platform, platformVersion: null };
  try {
    const h = await ua.getHighEntropyValues(["architecture", "bitness", "platform", "platformVersion", "model"]);
    return { arch: h.architecture ?? fb.arch, platform: h.platform ?? fb.platform, platformVersion: h.platformVersion ?? null };
  } catch { return { arch: fb.arch, platform: ua.platform ?? fb.platform, platformVersion: null }; }
}

export async function detectHardware(): Promise<HardwareProfile> {
  const gpu = await detectGpu();
  const ua = await detectUaHints();
  let storageGiB: number | null = null;
  try { const e = await navigator.storage?.estimate?.(); if (e?.quota != null) storageGiB = Math.round(((e.quota - (e.usage ?? 0)) / 1e9) * 10) / 10; } catch { /* unsupported */ }
  const conn = (navigator as any).connection;
  let onBattery: boolean | null = null, batteryLevel: number | null = null;
  try { const b = await (navigator as any).getBattery?.(); if (b) { onBattery = !b.charging; batteryLevel = typeof b.level === "number" ? b.level : null; } } catch { /* unsupported */ }
  // Mobile: prefer the authoritative UA-CH boolean; else a touchscreen AND coarse primary pointer (a
  // laptop trackpad is "fine", so it stays desktop). Avoids recommending a 20B model to a phone.
  const uaMobile = (navigator as any).userAgentData?.mobile;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const touch = (navigator.maxTouchPoints ?? 0) > 0;
  const gpuName = gpu?.description || gpu?.vendor || detectWebglGpu();
  return {
    ramGiB: (navigator as any).deviceMemory ?? null,
    cpuCores: navigator.hardwareConcurrency ?? null,
    arch: ua.arch,
    platform: ua.platform,
    platformVersion: ua.platformVersion,
    gpu,
    webgpu: !!(navigator as any).gpu,
    storageGiB,
    network: conn ? { effectiveType: conn.effectiveType ?? "", downlinkMbps: conn.downlink ?? 0, saveData: !!conn.saveData } : null,
    onBattery,
    batteryLevel,
    mobile: typeof uaMobile === "boolean" ? uaMobile : touch && coarse,
    gpuName,
    wasm: detectWasm(),
  };
}

export interface ModelRecommendation { tier: "cpu" | "small" | "medium" | "large"; note: string; examples: string[]; canRunInBrowser: boolean; budgetGB: number }

// GPU footprint budget for in-browser inference. WebGPU exposes no total-VRAM figure, so derive a
// budget: a RAM tier ceilinged by the GPU's single-buffer limit. Fallback (software) adapters get the
// floor. This is what tells the UI which in-browser model won't OOM.
export function gpuBudgetGB(p: HardwareProfile): number {
  if (!p.gpu || p.gpu.fallback) return 0.6;
  const ram = p.ramGiB ?? 8;
  const ramBudget = ram >= 8 ? 6 : ram >= 4 ? 2.5 : ram >= 2 ? 1.2 : 0.7;
  const bufCeil = Math.max((p.gpu.maxBufferMiB / 1000) * 0.9, 0.6);
  return Math.round(Math.min(ramBudget, bufCeil) * 10) / 10;
}

// Exact host hardware, measured by the bridge (system_profiler / sysctl / nvidia-smi) rather than the
// browser's privacy-limited APIs. Present only when the local bridge is running. Refines the coarse
// browser recommendation — WebGPU caps deviceMemory at 8 and hides VRAM, so a 64 GB Apple Silicon box
// looks like an 8 GB box until the bridge reports the real numbers.
export interface BridgeHardware {
  os: string;                  // "darwin" | "linux" | "win32"
  ramGiB: number | null;       // total system RAM
  vramGiB: number | null;      // dedicated GPU memory (≈ ramGiB on unified-memory Apple Silicon)
  cpuCores: number | null;
  chip: string | null;         // e.g. "Apple M2 Pro" or the Intel/AMD brand string
  gpuName: string | null;
  appleSilicon: boolean;       // unified memory ⇒ the GPU can address most of system RAM
  source: string;              // which probes answered ("sysctl", "nvidia-smi", …)
}

// One-line human summary of the exact host hardware, for the Connect screen.
export function bridgeSummary(hw: BridgeHardware): string {
  const mem = hw.appleSilicon && hw.ramGiB
    ? `${hw.ramGiB}GB unified`
    : [hw.vramGiB ? `${hw.vramGiB}GB VRAM` : null, hw.ramGiB ? `${hw.ramGiB}GB RAM` : null].filter(Boolean).join(" · ");
  return [hw.chip || hw.gpuName, mem].filter(Boolean).join(" · ");
}

// Refine the recommendation with exact host memory. The model has to fit in GPU memory to run fast;
// on unified-memory Apple Silicon that's (most of) system RAM, on a discrete GPU it's VRAM. `browser`
// carries WebGPU-derived canRunInBrowser through unchanged (the bridge can't see the browser's GPU).
export function recommendFromBridge(hw: BridgeHardware, browser?: ModelRecommendation): ModelRecommendation {
  const ram = hw.ramGiB ?? 4;
  const mem = hw.appleSilicon ? ram : Math.max(hw.vramGiB ?? 0, 0);
  const canRunInBrowser = browser?.canRunInBrowser ?? false;
  const budgetGB = browser?.budgetGB ?? 0;
  const where = hw.appleSilicon ? `${ram}GB unified memory` : `${mem}GB VRAM`;
  const base = { canRunInBrowser, budgetGB };
  if (mem < 6) return { tier: "small", note: `${where} — a 3–4B model comfortably.`, examples: ["llama3.2:3b", "qwen3:4b"], ...base };
  if (mem < 12) return { tier: "medium", note: `${where} — a 7–8B model, or a 14B quantized.`, examples: ["qwen3:8b", "gpt-oss:20b (Q4)"], ...base };
  if (mem < 24) return { tier: "medium", note: `${where} — a 14B, or a 20B quantized.`, examples: ["qwen3:14b", "gpt-oss:20b (Q4)"], ...base };
  if (mem < 48) return { tier: "large", note: `${where} — a 32B, or a 20B at full precision.`, examples: ["qwen3:32b", "gpt-oss:20b"], ...base };
  return { tier: "large", note: `${where} — a 70B quantized, or 32B at full precision.`, examples: ["llama3.3:70b (Q4)", "qwen3:32b"], ...base };
}

// Heuristic model-size recommendation. RAM/unified-memory dominates on Apple Silicon; GPU tier + f16
// gate whether in-browser WebGPU inference is worth attempting.
export function recommendModel(p: HardwareProfile): ModelRecommendation {
  const ram = p.ramGiB ?? 4;                 // deviceMemory caps at 8, so ≥8 is "8 or more"
  const goodGpu = !!p.gpu && !p.gpu.fallback && p.gpu.maxBufferMiB >= 256;
  const budgetGB = gpuBudgetGB(p);
  // A phone never runs a big model in-browser regardless of what WebGPU reports; cap it hard.
  if (p.mobile) return { tier: "cpu", note: "Mobile device — a tiny model only; prefer a local server over the network.", examples: ["llama3.2:1b", "qwen3:1.7b"], canRunInBrowser: false, budgetGB };
  // WebGPU is the fast path; without it, SIMD + threaded WASM can still run a small model on CPU.
  const wasmViable = p.wasm.simd && p.wasm.threads && ram >= 8;
  const canRunInBrowser = (p.webgpu && goodGpu && ram >= 8) || wasmViable;
  const base = { canRunInBrowser, budgetGB };
  if (!p.gpu || p.gpu.fallback || ram <= 2) return { tier: "cpu", note: wasmViable ? "No GPU, but SIMD+threaded WASM can run a small model on CPU." : "No usable GPU or low memory — small quantized model on CPU.", examples: ["llama3.2:1b", "qwen3:1.7b"], canRunInBrowser: wasmViable, budgetGB };
  if (ram <= 4) return { tier: "small", note: "Modest memory — a 3–4B model comfortably.", examples: ["llama3.2:3b", "qwen3:4b"], ...base };
  if (ram < 8 || !p.gpu.f16) return { tier: "medium", note: "Mid-range — an 7–8B model, or a 14B quantized.", examples: ["qwen3:8b", "gpt-oss:20b (Q4)"], ...base };
  return { tier: "large", note: "High memory + capable GPU — a 20B+ model, or 70B quantized on Apple Silicon.", examples: ["gpt-oss:20b", "qwen3:32b (Q4)"], ...base };
}
