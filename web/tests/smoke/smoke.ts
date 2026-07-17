// Smoke harness — imports the REAL modules and exercises the pure-browser pieces that the UI can't
// easily reach (in-browser Pyodide sandbox, sql.js, embeddings rerank, in-page MCP programmatically).
// Built with build-smoke.ts (same node-alias + external as build.ts), served, loaded headless; results
// land on window.__SMOKE and in the DOM. NOT shipped — a dev-only verification page.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Res = { name: string; ok: boolean; detail: string; ms: number };
const results: Res[] = [];
const w = globalThis as any;

async function test(name: string, fn: () => Promise<string>) {
  const t0 = performance.now();
  try { const detail = await fn(); results.push({ name, ok: true, detail, ms: Math.round(performance.now() - t0) }); }
  catch (e: any) { results.push({ name, ok: false, detail: String(e?.stack || e?.message || e).slice(0, 300), ms: Math.round(performance.now() - t0) }); }
  render();
}
function render() {
  w.__SMOKE = results;
  const done = results.length;
  document.body.innerHTML = `<pre style="font:13px monospace;padding:16px;color:#ddd;background:#14131a">` +
    results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}  (${r.ms}ms)\n   ${r.detail}`).join("\n\n") +
    `\n\n<span id="smoke-done">DONE ${done}</span></pre>`;
}

(async () => {
  // 1. sql.js — SQLite/WASM kv round-trip (CDN wasm)
  await test("sql.js kv round-trip", async () => {
    const sql = await import("../../src/lib/storage/sql");
    await sql.kvSet("smoke", { n: 42, s: "hi" });
    const v = await sql.kvGet<{ n: number; s: string }>("smoke");
    if (!v || v.n !== 42 || v.s !== "hi") throw new Error("round-trip mismatch: " + JSON.stringify(v));
    const rows = await sql.all("SELECT 1+1 AS two");
    if (rows[0]?.two !== 2) throw new Error("query failed");
    return `kvGet → ${JSON.stringify(v)}; SELECT 1+1 → ${rows[0].two}`;
  });

  // 2. in-page MCP — programmatic client over the shimmed stdio transport
  await test("in-page MCP round-trip", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InPageStdioTransport } = await import("../../src/lib/mcp/inpage");
    const client = new Client({ name: "smoke", version: "1" }, { capabilities: {} });
    await client.connect(new InPageStdioTransport("browser") as any);
    const tools = (await client.listTools()).tools.map((t: any) => t.name);
    const r: any = await client.callTool({ name: "get_current_time", arguments: {} });
    const text = r.content?.[0]?.text ?? "";
    await client.close();
    if (!tools.includes("get_current_time")) throw new Error("missing tool; got " + tools.join(","));
    if (!text) throw new Error("get_current_time returned empty");
    return `tools=[${tools.join(", ")}]; get_current_time → "${text.slice(0, 40)}"`;
  });

  // 3. in-browser sandbox — Pyodide + just-bash exec + V4A editor + python (CDN Pyodide ~10MB)
  await test("in-browser sandbox (Pyodide + just-bash + editor)", async () => {
    const { InBrowserSandboxClient } = await import("../../src/lib/sandbox/inbrowser/index");
    const s: any = await new InBrowserSandboxClient().create({ entries: {} });
    const echo = await s.exec({ cmd: "echo hello-automo" });
    if (!String(echo.stdout).includes("hello-automo")) throw new Error("bash echo: " + JSON.stringify(echo));
    const ed = s.createEditor();
    await ed.createFile({ type: "create_file", path: "smoke.txt", diff: "+line one\n+line two" });
    const back = new TextDecoder().decode(await s.readFile({ path: "smoke.txt" }));
    if (!back.includes("line one") || !back.includes("line two")) throw new Error("editor/readFile: " + JSON.stringify(back));
    const py = await s.runPython("print(6*7)");
    if (!String(py.stdout).includes("42")) throw new Error("python: " + JSON.stringify(py));
    const ls = await s.listDir({ path: "." });
    return `bash echo ok; editor+readFile ok (${JSON.stringify(back)}); python 6*7=42; listDir=${ls.length} entries`;
  });

  // 4. embeddings rerank — downloads all-MiniLM (~25MB); assert the on-topic doc ranks first
  await test("in-browser embeddings rerank", async () => {
    const { rerank } = await import("@automo/inference");
    const docs = ["A recipe for chocolate cake.", "How to configure a TypeScript compiler.", "The history of jazz music."];
    const ranked = await rerank("tsconfig and the typescript build", docs, 3);
    if (!ranked.length) throw new Error("empty ranking");
    if (ranked[0].index !== 1) throw new Error("expected doc#1 (typescript) first; got index " + ranked[0].index);
    return `top doc index=${ranked[0].index} score=${ranked[0].score.toFixed(3)} ("${docs[ranked[0].index].slice(0, 30)}")`;
  });

  const pass = results.filter((r) => r.ok).length;
  results.push({ name: "SUMMARY", ok: pass === results.length, detail: `${pass}/${results.length} passed`, ms: 0 });
  render();
})();
