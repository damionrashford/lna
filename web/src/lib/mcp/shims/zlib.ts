// node:zlib shim backed by fflate, wrapped so results are Node Buffers (server code calls .toString()).
import { gunzipSync as fg, gzipSync as fz, inflateSync as fi, deflateSync as fd } from "fflate";
import { Buffer } from "buffer";

/* eslint-disable @typescript-eslint/no-explicit-any */
const u8 = (b: any) => (b instanceof Uint8Array ? b : new Uint8Array(b));
export const gunzipSync = (b: any) => Buffer.from(fg(u8(b)));
export const gzipSync = (b: any) => Buffer.from(fz(u8(b)));
export const inflateSync = (b: any) => Buffer.from(fi(u8(b)));
export const deflateSync = (b: any) => Buffer.from(fd(u8(b)));
export default { gunzipSync, gzipSync, inflateSync, deflateSync };
