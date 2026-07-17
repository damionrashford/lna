// node:crypto shim — browser WebCrypto covers the surface stdio MCP servers use (randomUUID,
// getRandomValues, subtle).
/* eslint-disable @typescript-eslint/no-explicit-any */
const c: any = (globalThis as any).crypto;
export const randomUUID = () => c.randomUUID();
export const getRandomValues = (a: any) => c.getRandomValues(a);
export const webcrypto = c;
export default { randomUUID, getRandomValues, webcrypto };
