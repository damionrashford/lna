// Ambient module declarations for non-code imports Bun bundles but tsc doesn't know about.
declare module "*.css";
declare module "*.svg";
declare module "*.png";
declare module "*.webmanifest";
// Optional in-browser deps imported via literal dynamic import (bundled when installed, else externalized
// by build.ts). Declared loosely so tsc doesn't require their (sometimes absent) type packages.
declare module "sql.js";
declare module "just-bash/browser";
declare module "isomorphic-git";
declare module "isomorphic-git/http/web";
declare module "kokoro-js";
declare module "@huggingface/transformers";
declare module "@mlc-ai/web-llm";
