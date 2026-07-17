// web_search — a DuckDuckGo HTML-scraping tool for the SandboxAgent.
//
// DuckDuckGo's html/lite endpoints send no CORS headers, so a plain browser fetch can't read
// them. The tool tries several routes and uses whichever works:
//   1. CORS proxies from the browser — corsproxy.io, then allorigins (raw + JSON). No bridge needed.
//   2. the live sandbox `curl` (user's machine, no CORS) as a fallback when a session is running.
// DDG rate-limits scraping, so we also fall back from the html endpoint to the lighter lite one.
import { tool } from "@openai/agents";
import { z } from "zod";
import { S } from "../../store";
import { noSecretsToWeb, redactToolSecrets } from "../runtime/context/guardrails";
import { rerank } from "@automo/inference";
import { logEvent } from "../../store";

/* eslint-disable @typescript-eslint/no-explicit-any */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded target> — unwrap it.
function unwrap(href: string): string {
  try { const u = new URL(href, "https://duckduckgo.com"); const q = u.searchParams.get("uddg"); if (q) return decodeURIComponent(q); } catch { /* fall through */ }
  return href.startsWith("//") ? "https:" + href : href;
}

export type SearchResult = { title: string; url: string; snippet: string };

// html.duckduckgo.com/html/ — <a class="result__a" href> titles + <a class="result__snippet">
export function parseDdgHtml(html: string, max = 6): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => strip(m[1]));
  let m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(html)) && out.length < max) {
    const title = strip(m[2]); if (!title) { i++; continue; }
    out.push({ title, url: unwrap(m[1]), snippet: snips[i] || "" }); i++;
  }
  return out;
}

// lite.duckduckgo.com/lite/ — <a class="result-link"> + <td class="result-snippet">
export function parseDdgLite(html: string, max = 6): SearchResult[] {
  const out: SearchResult[] = [];
  const links = [...html.matchAll(/<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snips = [...html.matchAll(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
  for (let i = 0; i < links.length && out.length < max; i++) {
    const title = strip(links[i][2]); if (!title) continue;
    out.push({ title, url: unwrap(links[i][1]), snippet: snips[i] || "" });
  }
  return out;
}

// CORS proxies that let a browser read a cross-origin page. allorigins /get (JSON) is the one
// that actually works today — verified returning DDG results from a real browser Origin;
// corsproxy.io now 403s without a paid key and allorigins /raw fails CORS, kept only as fallbacks.
const PROXIES: ((u: string) => { url: string; json?: boolean })[] = [
  (u) => ({ url: `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, json: true }),
  (u) => ({ url: `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` }),
  (u) => ({ url: `https://corsproxy.io/?url=${encodeURIComponent(u)}` }),
];

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

// fetch a target page's HTML, trying browser proxies first, then the live sandbox's curl.
// `session` comes from the run's RunContext (see execute); null when no sandbox is running.
async function fetchPage(target: string, session: any): Promise<string> {
  for (const make of PROXIES) {
    const { url, json } = make(target);
    try {
      const r = await fetch(url, { headers: { Accept: "text/html,application/json" } });
      if (!r.ok) continue;
      const text = await r.text();
      const body = json ? (JSON.parse(text)?.contents ?? "") : text;
      if (body && body.length > 800) return body;
    } catch { /* try next */ }
  }
  if (session) {
    try {
      const cmd = `curl -sL --max-time 20 --compressed -A ${shq(UA)} -H 'Accept: text/html' -H 'Accept-Language: en-US,en;q=0.9' -H 'Referer: https://duckduckgo.com/' ${shq(target)}`;
      const r = await session.exec({ cmd });
      return (r?.stdout ?? r?.output ?? "") as string;
    } catch { /* give up */ }
  }
  return "";
}

export const webSearchTool = tool({
  name: "web_search",
  description: "Search the web via DuckDuckGo (HTML scraping) and return titles, URLs, and snippets. Use for current information or anything you're unsure of.",
  parameters: z.object({
    query: z.string().describe("the search query"),
    max_results: z.number().int().min(1).max(10).default(6).describe("how many results to return"),
  }),
  needsApproval: async () => S.approve, // human-in-the-loop when the Settings toggle is on
  inputGuardrails: [noSecretsToWeb],    // don't send credentials to the web
  outputGuardrails: [redactToolSecrets], // redact credentials from results
  execute: async ({ query, max_results }, runContext?: any) => {
    const session = runContext?.context?.session ?? null; // live sandbox from RunContext, for curl fallback
    const q = encodeURIComponent(query);
    const sources: [string, (h: string, n: number) => SearchResult[]][] = [
      ["https://html.duckduckgo.com/html/?q=" + q, parseDdgHtml],
      ["https://lite.duckduckgo.com/lite/?q=" + q, parseDdgLite],
    ];
    for (const [url, parse] of sources) {
      const html = await fetchPage(url, session);
      let res = parse(html, Math.max(max_results, 10)); // over-fetch so rerank has candidates to reorder
      if (res.length) { res = await rerankResults(query, res, max_results); return JSON.stringify(res); }
    }
    return `No results for "${query}" — DuckDuckGo or the CORS proxies may be rate-limiting scraping right now. Try again shortly, or run the local bridge so search can go through your own machine.`;
  },
});

// Reorder + dedupe search hits by semantic relevance to the query (in-browser embeddings). Best-effort:
// if the embedder dep isn't installed or errors, return the raw DDG order untouched.
async function rerankResults(query: string, results: SearchResult[], topK: number): Promise<SearchResult[]> {
  try {
    const docs = results.map((r) => `${r.title}. ${r.snippet}`);
    const ranked = await rerank(query, docs, topK);
    return ranked.map((r) => results[r.index]);
  } catch {
    return results.slice(0, topK); // no embedder → raw order
  }
}

const shqRead = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

export const readUrlTool = tool({
  name: "read_url",
  description: "Fetch a web page and return its readable text (HTML stripped). Give `focus` (what you're looking for) and an in-browser embedding model keeps only the most relevant passages of long pages.",
  parameters: z.object({
    url: z.string().describe("full http(s) URL to read"),
    focus: z.string().describe("what you want from this page — used to rank passages"),
  }),
  needsApproval: async () => S.approve,
  outputGuardrails: [redactToolSecrets],
  execute: async ({ url, focus }, runContext?: any) => {
    const session = runContext?.context?.session ?? null;
    let html = await fetchPage(url, session);
    if (!html && session) { try { const r = await session.exec({ cmd: `curl -sL --max-time 20 --compressed -A ${shqRead(UA)} ${shqRead(url)}` }); html = (r?.stdout ?? r?.output ?? "") as string; } catch { /* give up */ } }
    const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!text) return "(no readable text extracted)";
    if (text.length <= 4000) return text;
    // long page: chunk + keep the passages most relevant to focus (raw first-4k on embedder failure)
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 1200) chunks.push(text.slice(i, i + 1200));
    try {
      const ranked = await rerank(focus, chunks, 4);
      const top = ranked.sort((a, b) => a.index - b.index).map((r) => chunks[r.index]);
      return `(most relevant passages for "${focus}")\n\n` + top.join("\n…\n");
    } catch { logEvent("info", "read_url: no embedder, returning first 4k chars"); return text.slice(0, 4000); }
  },
});
