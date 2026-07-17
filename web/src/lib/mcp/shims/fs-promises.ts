// node:fs/promises shim — delegates to the async wrappers in fs.ts.
import { promises } from "./fs";
export const { readFile, access, readdir, stat, writeFile, mkdir } = promises;
export default promises;
