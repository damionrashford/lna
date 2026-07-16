// Make Node's Buffer a global before any bundled stdio server code runs. The MCP SDK's ReadBuffer
// (server-side stdio framing) calls Buffer.concat / .subarray / .toString('utf8'); browser bundles have
// no Buffer global, so we install the `buffer` polyfill. Ported from gh-pages-react/shims.
import { Buffer } from "buffer";
(globalThis as any).Buffer = (globalThis as any).Buffer ?? Buffer;
export {};
