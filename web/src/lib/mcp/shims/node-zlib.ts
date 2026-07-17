// Alternate node:zlib shim that returns raw Uint8Arrays (for callers like just-bash's gzip/gunzip/zcat
// that call gunzipSync etc. and don't need Node Buffers). Backed by fflate; maps Node's zlib names and
// constants to fflate equivalents.
import {
  gunzipSync as fGunzip, gzipSync as fGzip, unzlibSync as fInflate, zlibSync as fDeflate,
  inflateSync as fInflateRaw, deflateSync as fDeflateRaw,
} from "fflate";

/* eslint-disable @typescript-eslint/no-explicit-any */
const u8 = (b: any): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b));

export const gunzipSync = (b: any) => fGunzip(u8(b));
export const gzipSync = (b: any) => fGzip(u8(b));
export const inflateSync = (b: any) => fInflate(u8(b));
export const deflateSync = (b: any) => fDeflate(u8(b));
export const inflateRawSync = (b: any) => fInflateRaw(u8(b));
export const deflateRawSync = (b: any) => fDeflateRaw(u8(b));
const unsupported = (name: string) => () => { throw new Error("node:zlib " + name + " not supported in browser"); };
export const brotliCompressSync = unsupported("brotliCompressSync");
export const brotliDecompressSync = unsupported("brotliDecompressSync");

export const constants = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
  Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_STRATEGY: 0, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4,
  Z_DEFAULT_WINDOWBITS: 15, Z_DEFAULT_MEMLEVEL: 8,
};

export default { gunzipSync, gzipSync, inflateSync, deflateSync, inflateRawSync, deflateRawSync, brotliCompressSync, brotliDecompressSync, constants };
