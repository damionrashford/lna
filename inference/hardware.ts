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
      fallback: !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
    };
  } catch { return null; }
}

async function detectUaHints(): Promise<{ arch: string | null; platform: string | null; platformVersion: string | null }> {
  const ua = (navigator as any).userAgentData;
  if (!ua?.getHighEntropyValues) return { arch: null, platform: ua?.platform ?? null, platformVersion: null };
  try {
    const h = await ua.getHighEntropyValues(["architecture", "bitness", "platform", "platformVersion", "model"]);
    return { arch: h.architecture ?? null, platform: h.platform ?? null, platformVersion: h.platformVersion ?? null };
  } catch { return { arch: null, platform: ua.platform ?? null, platformVersion: null }; }
}

export async function detectHardware(): Promise<HardwareProfile> {
  const gpu = await detectGpu();
  const ua = await detectUaHints();
  let storageGiB: number | null = null;
  try { const e = await navigator.storage?.estimate?.(); if (e?.quota != null) storageGiB = Math.round(((e.quota - (e.usage ?? 0)) / 1e9) * 10) / 10; } catch { /* unsupported */ }
  const conn = (navigator as any).connection;
  let onBattery: boolean | null = null;
  try { const b = await (navigator as any).getBattery?.(); if (b) onBattery = !b.charging; } catch { /* unsupported */ }
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
  };
}

export interface ModelRecommendation { tier: "cpu" | "small" | "medium" | "large"; note: string; examples: string[]; canRunInBrowser: boolean }

// Heuristic model-size recommendation. RAM/unified-memory dominates on Apple Silicon; GPU tier + f16
// gate whether in-browser WebGPU inference is worth attempting.
export function recommendModel(p: HardwareProfile): ModelRecommendation {
  const ram = p.ramGiB ?? 4;                 // deviceMemory caps at 8, so ≥8 is "8 or more"
  const goodGpu = !!p.gpu && !p.gpu.fallback && p.gpu.maxBufferMiB >= 256;
  const canRunInBrowser = p.webgpu && goodGpu && ram >= 8;
  if (!p.gpu || p.gpu.fallback || ram <= 2) return { tier: "cpu", note: "No usable GPU or low memory — small quantized model on CPU.", examples: ["llama3.2:1b", "qwen3:1.7b"], canRunInBrowser: false };
  if (ram <= 4) return { tier: "small", note: "Modest memory — a 3–4B model comfortably.", examples: ["llama3.2:3b", "qwen3:4b"], canRunInBrowser };
  if (ram < 8 || !p.gpu.f16) return { tier: "medium", note: "Mid-range — an 7–8B model, or a 14B quantized.", examples: ["qwen3:8b", "gpt-oss:20b (Q4)"], canRunInBrowser };
  return { tier: "large", note: "High memory + capable GPU — a 20B+ model, or 70B quantized on Apple Silicon.", examples: ["gpt-oss:20b", "qwen3:32b (Q4)"], canRunInBrowser };
}
