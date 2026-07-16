// Stub for @shopify/theme-check-node. It drags in the vscode-languageservice UMD packages (dynamic
// require, not browser-bundleable) and only powers one validation tool. Stubbing keeps every other tool
// of a bundled Shopify dev-mcp working in-page. App-specific — alias to this only when bundling that
// server. Ported from gh-pages-react/shims.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function themeCheckRun() { return { offenses: [], theme: [] } as any; }
export const recommended: any[] = [];
export default { themeCheckRun, recommended };
