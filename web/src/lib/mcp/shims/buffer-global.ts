// Install Node's Buffer as a global before any bundled stdio server runs. The MCP SDK's ReadBuffer
// (server-side stdio framing) calls Buffer.concat/.subarray/.toString('utf8'), which browsers lack.
import { Buffer } from "buffer";
(globalThis as any).Buffer = (globalThis as any).Buffer ?? Buffer;
export {};
