// In-browser text embeddings + semantic rerank via transformers.js (@huggingface/transformers,
// feature-extraction). Reranks web-search hits by meaning and keeps only the passages of a long page
// relevant to a focus. Callers fall back to raw order if the dep isn't installed.
//
// Dep-gated dynamic import (variable specifier) so this bundles without `@huggingface/transformers`.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>; // one L2-normalized vector per input
  unload(): Promise<void>;
}

let embedderPromise: Promise<Embedder> | null = null;
// small 384-dim sentence-embedding model — good rerank quality at low cost
export async function getEmbedder(model = "Xenova/all-MiniLM-L6-v2"): Promise<Embedder> {
  if (embedderPromise) return embedderPromise;
  embedderPromise = (async () => {
    const tf: any = await import("@huggingface/transformers").catch(() => {
      throw new Error("Semantic rerank needs `@huggingface/transformers` — add it to embed in the browser.");
    });
    const device = (navigator as any).gpu ? "webgpu" : "wasm";
    const pipe = await tf.pipeline("feature-extraction", model, { device });
    return {
      async embed(texts: string[]) {
        const out = await pipe(texts, { pooling: "mean", normalize: true });
        return out.tolist() as number[][];
      },
      async unload() { try { await pipe?.dispose?.(); } catch { /* noop */ } },
    };
  })().catch((e) => { embedderPromise = null; throw e; });
  return embedderPromise;
}

// cosine similarity of two L2-normalized vectors is just the dot product
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface Ranked { index: number; score: number }

// Rank documents by semantic similarity to the query; optionally drop near-duplicates (keep the
// higher-ranked of any pair above `dedupe`). Returns indices into the original `documents` array.
export async function rerank(
  query: string, documents: string[], topK = 8, dedupe = 0.96, embedder?: Embedder,
): Promise<Ranked[]> {
  if (!documents.length) return [];
  const emb = embedder ?? (await getEmbedder());
  const vecs = await emb.embed([query, ...documents]);
  const q = vecs[0], docs = vecs.slice(1);
  const scored: Ranked[] = docs.map((v, index) => ({ index, score: cosine(q, v) })).sort((a, b) => b.score - a.score);
  const kept: Ranked[] = [];
  for (const cand of scored) {
    if (kept.length >= topK) break;
    if (kept.some((k) => cosine(docs[k.index], docs[cand.index]) >= dedupe)) continue; // near-duplicate
    kept.push(cand);
  }
  return kept;
}
