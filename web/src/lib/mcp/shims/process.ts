// Browser shim for `node:process`, focused on the stdio contract every stdio MCP server speaks: the
// server reads process.stdin and writes process.stdout. We expose hooks (onServerWrite / writeToServer)
// so an in-page MCP client can drive both ends — no spawn, no bridge. Ported from gh-pages-react/shims.
//
// One global process ⇒ ONE in-page stdio server at a time (matches the source). Servers that accept
// explicit streams can instead be handed a fresh pair via makeStdioPair() below.
import { Buffer } from "buffer";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (...args: any[]) => void;

export class Emitter {
  private listeners: Record<string, Listener[]> = {};
  on(ev: string, fn: Listener) { (this.listeners[ev] ??= []).push(fn); return this; }
  off(ev: string, fn: Listener) { this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== fn); return this; }
  once(ev: string, fn: Listener) { const w = (...a: any[]) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  emit(ev: string, ...args: any[]) { (this.listeners[ev] ?? []).slice().forEach((f) => f(...args)); }
  listenerCount(ev: string) { return (this.listeners[ev] ?? []).length; }
  removeListener(ev: string, fn: Listener) { return this.off(ev, fn); }
  pause() { return this; }
  resume() { return this; }
  setEncoding() { return this; }
}

// server's stdin (client → server). Buffers chunks written before the server attaches its 'data'
// listener (the server's main() may do slow async setup before connecting its transport).
export class Stdin extends Emitter {
  private pending: any[] = [];
  on(ev: string, fn: Listener) {
    super.on(ev, fn);
    if (ev === "data" && this.pending.length) { const q = this.pending; this.pending = []; q.forEach((c) => this.emit("data", c)); }
    return this;
  }
  push(chunk: any) { if (this.listenerCount("data") > 0) this.emit("data", chunk); else this.pending.push(chunk); }
}

// server's stdout (server → client). Buffers writes until a sink is registered so nothing is dropped.
export class Stdout extends Emitter {
  private sink: ((s: string) => void) | null = null;
  private pending: string[] = [];
  isTTY = false;
  write(chunk: any, _enc?: any, cb?: any) {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (this.sink) this.sink(s); else this.pending.push(s);
    if (typeof _enc === "function") _enc();
    if (typeof cb === "function") cb();
    return true;
  }
  onWrite(cb: (s: string) => void) { this.sink = cb; if (this.pending.length) { const q = this.pending.splice(0); q.forEach(cb); } }
}

// A fresh {stdin, stdout} pair — for servers we construct ourselves and hand explicit streams to
// (StdioServerTransport(stdin, stdout)); lets multiple in-page servers coexist.
export function makeStdioPair() {
  const stdin = new Stdin();
  const stdout = new Stdout();
  return {
    stdin, stdout,
    writeToServer: (line: string) => stdin.push(Buffer.from(line, "utf8")),
    onServerWrite: (cb: (s: string) => void) => stdout.onWrite(cb),
  };
}

// ---- the global singleton process (for servers that read the default process.stdin/stdout) ----
const stdin = new Stdin();
const stdout = new Stdout();
const stderr = Object.assign(new Emitter(), {
  write(chunk: any, _enc?: any, cb?: any) {
    try { (globalThis as any).__mcpServerLog?.(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); } catch { /* noop */ }
    if (typeof _enc === "function") _enc(); if (typeof cb === "function") cb(); return true;
  },
  isTTY: false,
});

export function onServerWrite(cb: (s: string) => void) { stdout.onWrite(cb); }
export function writeToServer(line: string) { stdin.push(Buffer.from(line, "utf8")); }

const proc: any = {
  stdin, stdout, stderr,
  env: { NODE_ENV: "production" }, argv: ["node", "server"], argv0: "node",
  platform: "browser", arch: "wasm", pid: 1, version: "v20.0.0", versions: { node: "20.0.0" },
  cwd: () => "/", chdir: () => {}, exit: () => {},
  on: () => proc, off: () => proc, once: () => proc, emit: () => false, removeListener: () => proc,
  nextTick: (fn: Listener, ...args: any[]) => queueMicrotask(() => fn(...args)),
  hrtime: Object.assign(() => [0, 0], { bigint: () => 0n }),
  umask: () => 0, binding: () => ({}), features: {},
};

// Some deps reference the bare global `process` (not an import) — expose it.
(globalThis as any).process = (globalThis as any).process ?? proc;
(globalThis as any).global = (globalThis as any).global ?? globalThis;

export default proc;
export const env = proc.env;
export const argv = proc.argv;
export const platform = proc.platform;
export { stdin, stdout, stderr };
export const nextTick = proc.nextTick;
export const cwd = proc.cwd;
