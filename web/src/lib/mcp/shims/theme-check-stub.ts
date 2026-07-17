// Stub for @shopify/theme-check-node. It drags in vscode-languageservice UMD packages (dynamic require,
// not browser-bundleable) and powers only one validation tool; stubbing keeps every other tool of a
// bundled Shopify dev MCP working in-page. Alias to this only when bundling that server.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function themeCheckRun() { return { offenses: [], theme: [] } as any; }
export const recommended: any[] = [];
export default { themeCheckRun, recommended };
